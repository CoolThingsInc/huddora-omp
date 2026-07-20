/**
 * Huddora OMP extension — background room chat delivery.
 *
 * Primary (architecture H): MCP SSE notifications/huddora/messages → sendMessage
 *   active: deliverAs steer; idle: nextTurn + triggerTurn
 * Notify: sole-consumer setOnNotification (default on); chain if getter exists
 * Safety: compatibility bridge only (profile access token) + poll recovery
 * Auth: definition-only mcp.json + /mcp reauth (no token scrape)
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	boundBatchForInject,
	DEBOUNCE_MS,
	defaultRateGuard,
	gateInject,
	type RateGuardState,
} from "./deliver";
import { COLLABORATION_GUIDANCE, COLLABORATION_GUIDANCE_VERSION, COLLABORATION_HELP } from "./guidance";
import { boundMessages, filterOwnMessages, formatRoomChatInjection, maxCursor } from "./format";
import {
	callHuddoraTool,
	getHuddoraConnectionStatus,
	mcpRoomList,
	setCompatibilityBridge,
} from "./mcp-client";
import { parseHuddoraMessagesNotification } from "./notifications";
import { advanceCursor, markError, nextPollDelayMs, restoreStateFromBranch } from "./state";
import { UnsafeHuddoraBridge, type UnsafeBridgeResult } from "./unsafe-bridge";
import {
	DEFAULT_PROJECT_CONFIG,
	loadProjectConfig,
	resolveProjectRoot,
	setDefaultRoom,
	writeProjectConfig,
} from "./project-config";
import { bootstrapRoom, durablePayload, longPollWaitMs, pullAndFormat } from "./sync";
import {
	decideRoomBinding,
	doctorNextStep,
	nextOnboardingDelayMs,
	roomToolFailureMessage,
	shouldResetOnboardingBudget,
} from "./onboarding";
import {
	CUSTOM_MSG_TYPE,
	CUSTOM_STATE_TYPE,
	defaultState,
	HEARTBEAT_MS,
	type HuddoraPluginState,
	INJECT_LIMIT,
	PLUGIN_VERSION,
	POLL_BASE_MS,
	POLL_MAX_MS,
	type RoomMessage,
} from "./types";

type TimerHandle = ReturnType<ExtensionContext["setInterval"]>;

export default function huddoraExtension(pi: ExtensionAPI) {
	pi.setLabel("Huddora");

	let state: HuddoraPluginState = defaultState();
	let timer: TimerHandle | null = null;
	let debounceTimer: TimerHandle | null = null;
	let heartbeatTimer: TimerHandle | null = null;
	let inFlight = false;
	let shutdown = false;
	let nextDueAt = 0;
	let delivery: "poll" | "bridge" | "unavailable" | "unknown" = "unknown";
	const injectedCursors = new Set<number>();
	let pendingBatch: RoomMessage[] = [];
	let pendingNextCursor: number | null = null;
	let liveCtx: ExtensionContext | null = null;
	let rateGuard: RateGuardState = defaultRateGuard();
	let lastPushAt: number | null = null;
	let bridge: UnsafeHuddoraBridge | null = null;
	let heartbeatInFlight = false;
	let onboardingTimer: TimerHandle | null = null;
	let onboardingInFlight = false;
	let onboardingAttempts = 0;
	let lastOnboardStatus: string | null = null;

	function persist(next: HuddoraPluginState) {
		state = next;
		pi.appendEntry(CUSTOM_STATE_TYPE, durablePayload(next));
	}

	function restore(ctx: ExtensionContext) {
		state = restoreStateFromBranch(ctx.sessionManager.getBranch());
	}

	function injectGuidance(ctx: ExtensionContext, root: string) {
		const key = `${root}:${COLLABORATION_GUIDANCE_VERSION}`;
		if (state.guidanceProjectKey === key) return;
		pi.sendMessage(
			{
				customType: "huddora-guidance",
				content: COLLABORATION_GUIDANCE,
				display: false,
				attribution: "agent",
				details: { guidanceVersion: COLLABORATION_GUIDANCE_VERSION },
			},
			{ deliverAs: "nextTurn", triggerTurn: false },
		);
		persist({ ...state, guidanceProjectKey: key });
	}

	async function bindRoom(
		ctx: ExtensionContext,
		root: string,
		roomId: string,
		source: "config" | "single" | "session" | "legacy",
		preserveCursor = false,
	): Promise<boolean> {
		const priorCursor = state.cursor;
		const boot = await bootstrapRoom(state, roomId);
		if (!boot.ok) {
			persist(boot.state);
			return false;
		}
		persist({ ...boot.state, cursor: preserveCursor ? priorCursor : boot.state.cursor, projectRoot: root });
		injectedCursors.clear();
		rateGuard = defaultRateGuard();
		await startDelivery(ctx);
		injectGuidance(ctx, root);
		if (source === "single") ctx.ui.notify(`Huddora: ${boot.state.roomName ?? "room"} connected. Use /huddora room to remember it for this project.`, "info");
		return true;
	}

	async function autoConnect(ctx: ExtensionContext): Promise<boolean> {
		if (onboardingInFlight || shutdown || state.paused) return Boolean(state.roomId);
		onboardingInFlight = true;
		try {
			const root = await resolveProjectRoot(ctx.cwd);
			const loaded = await loadProjectConfig(root);
			if (!loaded.ok) {
				ctx.ui.notify(`Huddora config ignored: ${loaded.error}. Run /huddora init to replace it.`, "warning");
				return false;
			}
			if (state.roomId && state.projectRoot && state.projectRoot !== root) {
				await huddoraCall("room_unwatch", { room_id: state.roomId });
				persist({ ...state, roomId: null, roomName: null, cursor: 0, projectRoot: root });
			}
			if (state.roomId && state.projectRoot === root) {
				await startDelivery(ctx);
				injectGuidance(ctx, root);
				return true;
			}
			// Bridge-only: ensure compatibility bridge before listing/binding rooms.
			if (!(await ensureTransport(ctx))) {
				return false;
			}
			let rooms: Array<{ room_id: string }> = [];
			const needsRooms = !loaded.config.default_room_id && !(state.roomId && state.projectRoot === null);
			if (needsRooms) {
				const listed = await mcpRoomList();
				if (!listed.ok) return false;
				rooms = listed.data;
			}
			const decision = decideRoomBinding({
				root,
				configRoomId: loaded.config.default_room_id,
				stateRoomId: state.roomId,
				stateProjectRoot: state.projectRoot,
				rooms,
				transportReady: true,
			});
			if (decision.action === "bind") {
				return bindRoom(ctx, root, decision.roomId, decision.source, decision.preserveCursor);
			}
			if (decision.action === "prompt_empty") {
				ctx.ui.notify("Huddora: no rooms yet. Create or join one at huddora.coolthings.fyi.", "info");
			} else if (decision.action === "prompt_choose") {
				ctx.ui.notify("Huddora: choose a room once with /huddora room <id>.", "info");
			}
			return false;
		} finally {
			onboardingInFlight = false;
		}
	}

	function scheduleOnboarding(ctx: ExtensionContext, reset = false) {
		if (reset) {
			onboardingAttempts = 0;
			lastOnboardStatus = null;
		}
		if (onboardingTimer) {
			ctx.clearTimer(onboardingTimer);
			onboardingTimer = null;
		}
		const attempt = async () => {
			if (shutdown || state.paused) return;
			const status = await getHuddoraConnectionStatus();
			// Any real status change re-arms the aggressive budget (covers late /mcp reauth).
			if (shouldResetOnboardingBudget(lastOnboardStatus, status)) onboardingAttempts = 0;
			if (status !== lastOnboardStatus) lastOnboardStatus = status;
			const connected = await autoConnect(ctx);
			if (connected || shutdown || state.paused) {
				if (onboardingTimer) {
					ctx.clearTimer(onboardingTimer);
					onboardingTimer = null;
				}
				return;
			}
			onboardingAttempts += 1;
			// Aggressive retries first, then slow re-arm forever so a later reauth/credential
			// write is observed without requiring /huddora connect or a session restart.
			const delay = nextOnboardingDelayMs(onboardingAttempts);
			onboardingTimer = ctx.setTimeout(() => void attempt(), delay);
		};
		void attempt();
	}

	function clearTimer(ctx: ExtensionContext) {
		if (timer) {
			ctx.clearTimer(timer);
			timer = null;
		}
		if (debounceTimer) {
			ctx.clearTimer(debounceTimer);
			debounceTimer = null;
		}
		if (heartbeatTimer) {
			ctx.clearTimer(heartbeatTimer);
			heartbeatTimer = null;
		}
		if (onboardingTimer) {
			ctx.clearTimer(onboardingTimer);
			onboardingTimer = null;
		}
	}

	/**
	 * Mid-turn policy (midturn report):
	 * active → steer; idle → nextTurn + triggerTurn.
	 * Rate/dedupe via gateInject. Never sendUserMessage for peers.
	 */
	function queueInject(content: string, cursorAfter: number, messageCount: number) {
		const isIdle = liveCtx ? liveCtx.isIdle() : true;
		const gated = gateInject(rateGuard, { isIdle, content, noise: messageCount === 0 });
		if (!gated) return false;
		rateGuard = gated.guard;
		pi.sendMessage(
			{
				customType: CUSTOM_MSG_TYPE,
				content,
				display: true,
				attribution: "agent",
				details: {
					roomId: state.roomId,
					cursorAfter,
					messageCount,
					pluginVersion: PLUGIN_VERSION,
					agentId: state.selfAgentId,
				},
			},
			gated.options,
		);
		return true;
	}

	function flushPending(ctx: ExtensionContext) {
		if (debounceTimer) {
			ctx.clearTimer(debounceTimer);
			debounceTimer = null;
		}
		if (!state.roomId || state.paused || pendingBatch.length === 0) {
			pendingBatch = [];
			pendingNextCursor = null;
			return;
		}
		let batch = filterOwnMessages(pendingBatch, state.selfUserId, state.selfAgentId);
		batch = boundMessages(batch, INJECT_LIMIT);
		batch = boundBatchForInject(batch);
		const maxAll = maxCursor(pendingBatch);
		const nextCursor = pendingNextCursor;
		pendingBatch = [];
		pendingNextCursor = null;

		const advanced = advanceCursor(state, {
			nextCursor,
			maxMessageCursor: maxAll,
		});

		if (batch.length === 0) {
			if (advanced.cursor !== state.cursor) persist(advanced);
			return;
		}

		if (injectedCursors.has(advanced.cursor)) {
			persist(advanced);
			return;
		}

		const content = formatRoomChatInjection({
			roomId: state.roomId,
			roomName: state.roomName,
			messages: batch,
			cursorAfter: advanced.cursor,
		});
		const queued = queueInject(content, advanced.cursor, batch.length);
		if (queued) {
			injectedCursors.add(advanced.cursor);
			persist(advanced);
			ctx.ui.notify(`Huddora: +${batch.length} msg (cursor ${advanced.cursor})`, "info");
		}
	}

	function enqueueMessages(
		ctx: ExtensionContext,
		messages: RoomMessage[],
		nextCursor: number | null,
	) {
		if (!state.roomId || state.paused) return;
		if (messages.length > 0) lastPushAt = Date.now();
		pendingBatch.push(...messages);
		if (nextCursor !== null) {
			pendingNextCursor =
				pendingNextCursor === null ? nextCursor : Math.max(pendingNextCursor, nextCursor);
		} else {
			const m = maxCursor(messages);
			if (m !== null) {
				pendingNextCursor = pendingNextCursor === null ? m : Math.max(pendingNextCursor, m);
			}
		}
		if (debounceTimer) ctx.clearTimer(debounceTimer);
		debounceTimer = ctx.setTimeout(() => {
			flushPending(ctx);
		}, DEBOUNCE_MS);
	}


	async function ensureBridge(ctx: ExtensionContext): Promise<boolean> {
		// Bridge is always-on transport. One-shot disclosure; decline only blocks this attempt.
		if (!state.bridgeDisclosureSeen && ctx.hasUI) {
			const accepted = await ctx.ui.confirm(
				"Huddora plugin MCP session",
				"Huddora will read only the current Huddora access token and expiry from this profile's local agent database, open a direct Huddora MCP session for plugin tools, and never read refresh tokens or other credentials. Continue?",
			);
			if (!accepted) {
				persist({
					...state,
					bridgeDisclosureSeen: true,
					lastError: "plugin MCP session disclosure declined — run /huddora connect to retry",
				});
				return false;
			}
			persist({ ...state, bridgeDisclosureSeen: true, bridgeDisabled: false, lastError: null });
		}
		if (!bridge) {
			bridge = new UnsafeHuddoraBridge();
			const started = await bridge.start((method, params) => {
				if (method !== "notifications/huddora/messages") return;
				const parsed = parseHuddoraMessagesNotification(method, params);
				if (!parsed || (state.roomId && parsed.roomId !== state.roomId)) return;
				const c = liveCtx ?? ctx;
				enqueueMessages(c, parsed.messages, parsed.nextCursor);
			});
			if (!started.ok) {
				bridge = null;
				persist(markError(state, started.message));
				return false;
			}
			setCompatibilityBridge(async (toolName, args) => {
				const result = await bridge?.callTool(toolName, args);
				if (result?.ok) return result;
				return { ok: false, error: { kind: "no_host_api", message: result?.message ?? "Compatibility bridge unavailable." } };
			});
		}
		delivery = "bridge";
		return true;
	}

	/** Plugin tools always use the compatibility bridge. */
	async function ensureTransport(ctx: ExtensionContext): Promise<boolean> {
		return ensureBridge(ctx);
	}

	async function huddoraCall(toolName: string, args: Record<string, unknown> = {}): Promise<UnsafeBridgeResult<unknown>> {
		// Bridge-only tool path.
		const result = await callHuddoraTool(toolName, args);
		if (result.ok) return result;
		if (bridge) return bridge.callTool(toolName, args);
		return { ok: false, message: result.error.message };
	}


	async function callRegister(): Promise<boolean> {
		const res = await huddoraCall("agent_register", {
			display_name: state.agentDisplayName
				? state.agentDisplayName
				: state.selfDisplayName
					? `${state.selfDisplayName}'s OMP`
					: "OMP agent",
			harness: "omp",
			extension_version: PLUGIN_VERSION,
			delivery_mode: delivery === "bridge" ? "mcp_push" : "poll",
		});
		if (!res.ok || !res.data || typeof res.data !== "object") {
			persist(markError(state, res.ok === false ? res.message : "agent_register_failed"));
			return false;
		}
		const id = Reflect.get(res.data, "agent_id");
		const name = Reflect.get(res.data, "display_name");
		if (typeof id !== "string") return false;
		persist({
			...state,
			selfAgentId: id,
			agentDisplayName: typeof name === "string" ? name : state.agentDisplayName,
			lastError: null,
		});
		return true;
	}
	async function ensureAgentRegistered(): Promise<void> {
		if (state.selfAgentId) return;
		await callRegister();
	}
	async function heartbeatTick() {
		if (shutdown || state.paused || heartbeatInFlight) return;
		heartbeatInFlight = true;
		try {
			const mode = delivery === "bridge" ? "mcp_push" : "poll";
			if (!state.selfAgentId) {
				if (await callRegister()) scheduleHeartbeat(liveCtx!);
				return;
			}
			const res = await huddoraCall("agent_heartbeat", { extension_version: PLUGIN_VERSION, delivery_mode: mode });
			if (res.ok) return;
			const msg = res.message.toLowerCase();
			if (msg.includes("revoked")) {
				persist({ ...state, selfAgentId: null, agentDisplayName: null, lastError: "agent revoked — open /account/agents" });
				clearTimer(liveCtx!);
				return;
			}
			persist({ ...state, lastError: `heartbeat: ${res.message}` });
			if (await callRegister()) {
				const retry = await huddoraCall("agent_heartbeat", { extension_version: PLUGIN_VERSION, delivery_mode: mode });
				if (!retry.ok) persist({ ...state, lastError: `heartbeat: ${retry.message}` });
			}
		} finally {
			heartbeatInFlight = false;
		}
	}
	function scheduleHeartbeat(ctx: ExtensionContext) {
		if (heartbeatTimer) {
			ctx.clearTimer(heartbeatTimer);
			heartbeatTimer = null;
		}
		if (shutdown || !state.selfAgentId) return;
		heartbeatTimer = ctx.setInterval(() => {
			void heartbeatTick();
		}, HEARTBEAT_MS);
	}

	async function ensureWatch(): Promise<void> {
		if (!state.roomId || state.paused) return;
		const res = await huddoraCall("room_watch", {
			room_id: state.roomId,
			after_cursor: state.cursor,
		});
		if (!res.ok) {
			delivery = "poll";
			return;
		}
		delivery = "bridge";
	}

	function schedulePoll(ctx: ExtensionContext, delayMs?: number) {
		if (timer) {
			ctx.clearTimer(timer);
			timer = null;
		}
		if (shutdown || !state.roomId || state.paused) return;
		const base = delivery === "bridge" ? Math.max(POLL_BASE_MS * 4, 30_000) : POLL_BASE_MS;
		const delay = delayMs ?? nextPollDelayMs(state, base, POLL_MAX_MS);
		nextDueAt = Date.now() + delay;
		timer = ctx.setInterval(() => {
			void pollTick(ctx);
		}, delay);
	}

	async function pollTick(ctx: ExtensionContext) {
		if (timer) {
			ctx.clearTimer(timer);
			timer = null;
		}
		if (shutdown || !state.roomId || state.paused || inFlight) {
			if (!shutdown && state.roomId && !state.paused) schedulePoll(ctx);
			return;
		}
		if (!(await ensureTransport(ctx))) {
			delivery = "unavailable";
			return;
		}
		inFlight = true;
		try {
			const outcome = await pullAndFormat(state, {
				waitMs: delivery === "poll" ? longPollWaitMs(false) : 0,
			});
			if (outcome.kind === "injected") {
				if (!injectedCursors.has(outcome.cursorAfter)) {
					const queued = queueInject(outcome.content, outcome.cursorAfter, outcome.messageCount);
					if (queued) injectedCursors.add(outcome.cursorAfter);
				}
				persist(outcome.state);
			} else if (outcome.kind === "empty" || outcome.kind === "error") {
				persist(outcome.state);
			}
		} catch (error) {
			persist(markError(state, error instanceof Error ? error.message : String(error)));
		} finally {
			inFlight = false;
			if (!shutdown && state.roomId && !state.paused) schedulePoll(ctx);
		}
	}

	async function syncNow(): Promise<string> {
		if (!state.roomId) return "No room selected. /huddora room <id>";
		if (!bridge && !(liveCtx && (await ensureBridge(liveCtx)))) {
			return "Huddora plugin MCP session unavailable. Run /mcp reauth huddora if needed, then /huddora connect.";
		}
		if (inFlight) return "In flight; retry shortly.";
		inFlight = true;
		try {
			const outcome = await pullAndFormat(state, { waitMs: 0 });
			if (outcome.kind === "injected") {
				if (!injectedCursors.has(outcome.cursorAfter)) {
					queueInject(outcome.content, outcome.cursorAfter, outcome.messageCount);
					injectedCursors.add(outcome.cursorAfter);
				}
				persist(outcome.state);
				return `Injected ${outcome.messageCount}; cursor=${outcome.cursorAfter}`;
			}
			if (outcome.kind === "empty") {
				persist(outcome.state);
				return `No new messages (cursor=${outcome.state.cursor})`;
			}
			if (outcome.kind === "error") {
				persist(outcome.state);
				return `Error: ${outcome.message}`;
			}
			return "No room.";
		} finally {
			inFlight = false;
		}
	}

	async function statusText(): Promise<string> {
		const conn = await getHuddoraConnectionStatus();
		const bridgeStatus = bridge
			? "active (auto)"
			: "starting — needs OAuth token after /mcp reauth huddora";
		return [
			`Huddora: ${state.roomName ?? "no room"} · ${delivery} · ${state.paused ? "paused" : "active"}`,
			`Plugin: ${conn}; agent: ${state.selfAgentId ? "registered" : "not registered"}; session: ${bridgeStatus}.`,
			state.lastError ? `Next: ${state.lastError}` : state.roomId ? "Ready." : "Next: /huddora room",
		].join("\n");
	}

	async function startDelivery(ctx: ExtensionContext) {
		liveCtx = ctx;
		if (!state.roomId || state.paused) return;
		if (!(await ensureBridge(ctx))) {
			delivery = "unavailable";
			ctx.ui.notify(
				"Huddora: plugin MCP session unavailable. Run /mcp reauth huddora if OAuth expired, then /huddora connect.",
				"error",
			);
			return;
		}
		await ensureWatch();
		await ensureAgentRegistered();
		scheduleHeartbeat(ctx);
		schedulePoll(ctx, 1_000);
	}

	pi.on("session_start", async (_e, ctx) => {
		shutdown = false;
		liveCtx = ctx;
		restore(ctx);
		scheduleOnboarding(ctx, true);
	});

	pi.on("session_switch", async (_e, ctx) => {
		liveCtx = ctx;
		restore(ctx);
		clearTimer(ctx);
		scheduleOnboarding(ctx, true);
	});

	pi.on("session_branch", async (_e, ctx) => {
		liveCtx = ctx;
		restore(ctx);
		injectedCursors.clear();
		rateGuard = defaultRateGuard();
		clearTimer(ctx);
		scheduleOnboarding(ctx, true);
	});

	pi.on("session_tree", async (_e, ctx) => {
		liveCtx = ctx;
		restore(ctx);
		clearTimer(ctx);
		scheduleOnboarding(ctx, true);
	});

	pi.on("session_shutdown", async (_e, ctx) => {
		shutdown = true;
		flushPending(ctx);
		clearTimer(ctx);
		inFlight = false;
		liveCtx = null;
		if (state.roomId) await huddoraCall("room_unwatch", { room_id: state.roomId });
		if (bridge) {
			await bridge.close();
			bridge = null;
			setCompatibilityBridge(null);
		}
	});

	pi.registerCommand("huddora", {
		description: "Huddora: init|config|room|help|status|doctor|connect|push|pause|resume|sync|disconnect",
		handler: async (args, ctx) => {
			liveCtx = ctx;
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] ?? "status").toLowerCase();
			const rest = parts.slice(1);

			switch (sub) {
				case "connect": {
					// Re-arm auto bridge + allow re-prompt after disclosure decline.
					persist({ ...state, bridgeDisabled: false, bridgeDisclosureSeen: false, lastError: null });
					scheduleOnboarding(ctx, true);
					return;
				}
				case "status":
					ctx.ui.notify(await statusText(), "info");
					return;
				case "help":
					ctx.ui.notify(COLLABORATION_HELP, "info");
					return;
				case "init": {
					try {
						await writeProjectConfig(ctx.cwd, DEFAULT_PROJECT_CONFIG);
						ctx.ui.notify("Huddora project config created. Re-run /mcp reauth huddora or reload to auto-connect.", "info");
					} catch (error) {
						ctx.ui.notify(`Huddora config: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
					return;
				}
				case "config": {
					const config = await loadProjectConfig(ctx.cwd);
					ctx.ui.notify(config.ok ? JSON.stringify(config.config, null, 2) : `Huddora config: ${config.error}`, config.ok ? "info" : "error");
					return;
				}
				case "doctor": {
					const config = await loadProjectConfig(ctx.cwd);
					const connection = await getHuddoraConnectionStatus();
					const deliveryLabel = bridge ? "bridge" : delivery;
					const transportReady = deliveryLabel === "bridge" || Boolean(bridge);
					const next = doctorNextStep({
						roomId: state.roomId,
						connection,
						delivery: deliveryLabel,
						bridgeError: state.lastError,
					});
					ctx.ui.notify(
						`Huddora doctor\nPlugin: ${connection}\nSession: ${bridge ? "active" : "not started"}\nConfig: ${config.ok ? (config.exists ? "valid" : "missing") : config.error}\nRoom: ${state.roomName ?? "none"}\nDelivery: ${deliveryLabel}\nNext: ${next}`,
						state.roomId || transportReady ? "info" : "warning",
					);
					return;
				}
				case "room": {
					const roomId = rest[0];
					if (!roomId) {
						if (!(await ensureTransport(ctx))) {
							ctx.ui.notify(
								"Plugin MCP session unavailable. Run /mcp reauth huddora if OAuth expired, then /huddora connect.",
								"warning",
							);
							return;
						}
						const rooms = await mcpRoomList();
						if (!rooms.ok) {
							ctx.ui.notify(roomToolFailureMessage(rooms.error), "warning");
							return;
						}
						ctx.ui.notify(
							rooms.data.length === 0
								? "No rooms yet. Create or join one at huddora.coolthings.fyi, then retry /huddora room."
								: `Rooms:\n${rooms.data.map(room => `  ${room.room_id}  ${room.name}`).join("\n")}\n\n/huddora room <id>`,
							"info",
						);
						return;
					}
					const root = await resolveProjectRoot(ctx.cwd);
					if (!(await ensureTransport(ctx))) {
						ctx.ui.notify("Plugin MCP session unavailable; cannot bind room. /mcp reauth huddora then /huddora connect.", "error");
						return;
					}
					if (!(await bindRoom(ctx, root, roomId, "session"))) {
						ctx.ui.notify("Huddora: room is unavailable.", "error");
						return;
					}
					const remember =
						!ctx.hasUI ||
						(await ctx.ui.confirm(
							"Remember Huddora room?",
							"Save this room id as the project default in .huddora/config.json for this OMP project root?",
						));
					if (!remember) {
						ctx.ui.notify("Huddora room bound for this session only.", "info");
						return;
					}
					try {
						await setDefaultRoom(root, roomId);
						ctx.ui.notify("Huddora room saved for this project.", "info");
					} catch (error) {
						ctx.ui.notify(`Huddora connected, but could not save project config: ${error instanceof Error ? error.message : String(error)}`, "warning");
					}
					return;
				}
				case "push": {
					const arg = (rest[0] ?? "").toLowerCase();
					if (arg === "on" || arg === "1" || arg === "true") {
						persist({ ...state, pushEnabled: true });
						await startDelivery(ctx);
						ctx.ui.notify(
							`Push preference on [${delivery}] (bridge SSE + poll).`,
							"info",
						);
						return;
					}
					if (arg === "off" || arg === "0" || arg === "false") {
						persist({ ...state, pushEnabled: false });
						delivery = "poll";
						if (state.roomId && !state.paused) {
							await ensureAgentRegistered();
							scheduleHeartbeat(ctx);
							schedulePoll(ctx, 1_000);
						}
						ctx.ui.notify("Push off — poll/long-poll only.", "info");
						return;
					}
					ctx.ui.notify(
						`push=${state.pushEnabled ? "on" : "off"} (bridge SSE). Usage: /huddora push on|off`,
						"info",
					);
					return;
				}
				case "pause":
					persist({ ...state, paused: true });
					clearTimer(ctx);
					if (state.roomId) void huddoraCall("room_unwatch", { room_id: state.roomId });
					ctx.ui.notify("Paused.", "info");
					return;
				case "resume":
					if (!state.roomId) {
						ctx.ui.notify("No room.", "warning");
						return;
					}
					persist({ ...state, paused: false, emptyStreak: 0, errorStreak: 0 });
					await startDelivery(ctx);
					ctx.ui.notify(`Resumed [${delivery}].`, "info");
					return;
				case "sync": {
					const msg = await syncNow();
					ctx.ui.notify(msg, msg.startsWith("Error") ? "error" : "info");
					return;
				}
				case "disconnect":
					clearTimer(ctx);
					if (state.roomId) await huddoraCall("room_unwatch", { room_id: state.roomId });
					if (bridge) await bridge.close();
					bridge = null;
					setCompatibilityBridge(null);
					delivery = "unavailable";
					persist(defaultState());
					injectedCursors.clear();
					rateGuard = defaultRateGuard();
					ctx.ui.notify("Disconnected.", "info");
					return;
				default:
					ctx.ui.notify(
						"Usage: /huddora init|config|room [id]|help|status|doctor|connect|push on|off|pause|resume|sync|disconnect",
						"warning",
					);
					return;
			}
		},
	});
}

/**
 * Huddora OMP extension — background room chat delivery.
 *
 * Primary (architecture H): MCP SSE notifications/huddora/messages → sendMessage
 *   active: deliverAs steer; idle: nextTurn + triggerTurn
 * Notify: sole-consumer setOnNotification (default on); chain if getter exists
 * Safety: host callTool poll/long-poll always (recovery)
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
import { boundMessages, filterOwnMessages, formatRoomChatInjection, maxCursor } from "./format";
import {
	callHuddoraTool,
	getHuddoraConnectionStatus,
	mcpRoomList,
	resolveHostMcp,
} from "./mcp-client";
import { parseHuddoraMessagesNotification } from "./notifications";
import { installChainedNotificationHandler, type NotifyHook } from "./notify-hook";
import { advanceCursor, markError, nextPollDelayMs, restoreStateFromBranch } from "./state";
import { bootstrapRoom, durablePayload, longPollWaitMs, pullAndFormat } from "./sync";
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
	let hostMode: "host_manager" | "unavailable" | "unknown" = "unknown";
	let delivery: "notifications" | "poll" | "unavailable" | "unknown" = "unknown";
	let notifyHook: NotifyHook | null = null;
	const injectedCursors = new Set<number>();
	let pendingBatch: RoomMessage[] = [];
	let pendingNextCursor: number | null = null;
	let liveCtx: ExtensionContext | null = null;
	let rateGuard: RateGuardState = defaultRateGuard();
	let lastPushAt: number | null = null;
	let pushWarnOnce = false;

	function persist(next: HuddoraPluginState) {
		state = next;
		pi.appendEntry(CUSTOM_STATE_TYPE, durablePayload(next));
	}

	function restore(ctx: ExtensionContext) {
		state = restoreStateFromBranch(ctx.sessionManager.getBranch());
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

	async function ensureHostMode(): Promise<"host_manager" | "unavailable"> {
		if (hostMode === "host_manager" || hostMode === "unavailable") return hostMode;
		const r = await resolveHostMcp();
		hostMode = r.mode;
		return hostMode;
	}

	async function hookNotifications(ctx: ExtensionContext): Promise<boolean> {
		if (!state.pushEnabled) {
			notifyHook?.restore();
			notifyHook = null;
			return false;
		}
		if (notifyHook?.installed) return true;
		const mode = await ensureHostMode();
		if (mode !== "host_manager") return false;
		try {
			const mod = await import("@oh-my-pi/pi-coding-agent/mcp");
			const MCPManager = mod.MCPManager as {
				instance: () =>
					| {
							setOnNotification?: (h: (s: string, m: string, p: unknown) => void) => void;
							getOnNotification?: () => ((s: string, m: string, p: unknown) => void) | undefined;
							onNotification?: (h: (s: string, m: string, p: unknown) => void) => () => void;
					  }
					| undefined;
			};
			const manager = MCPManager.instance?.();
			if (!manager) return false;

			// Architecture H: sole-consumer default (user installed for chat push).
			notifyHook = installChainedNotificationHandler(
				manager,
				(serverName, method, params) => {
					// Strict filter — never claim exclusivity security; only process Huddora chat.
					if (serverName !== "huddora") return;
					const parsed = parseHuddoraMessagesNotification(method, params);
					if (!parsed) return;
					if (state.roomId && parsed.roomId !== state.roomId) return;
					const c = liveCtx ?? ctx;
					enqueueMessages(c, parsed.messages, parsed.nextCursor);
				},
				{ soleConsumer: true },
			);
			if (notifyHook.installed) {
				delivery = "notifications";
				if (notifyHook.mode === "sole_consumer" && !pushWarnOnce) {
					pushWarnOnce = true;
					ctx.ui.notify(
						"Huddora: live push on (OMP notification slot). Other MCP notify listeners may need /huddora push off.",
						"info",
					);
				}
				return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	async function callRegister(): Promise<boolean> {
		const res = await callHuddoraTool("agent_register", {
			display_name: state.agentDisplayName
				? state.agentDisplayName
				: state.selfDisplayName
					? `${state.selfDisplayName}'s OMP`
					: "OMP agent",
			harness: "omp",
			extension_version: PLUGIN_VERSION,
			delivery_mode: delivery === "notifications" ? "mcp_push" : "poll",
		});
		if (!res.ok || !res.data || typeof res.data !== "object") {
			persist(markError(state, res.ok === false ? res.error.message : "agent_register_failed"));
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

	/**
	 * Always re-register on start/new transport so server session hub rebinds.
	 * agent_register is idempotent (oauth client_id or owner+harness singleton).
	 */
	async function ensureAgentRegistered(): Promise<void> {
		await callRegister();
	}

	async function heartbeatTick() {
		if (state.paused) return;
		const mode = delivery === "notifications" ? "mcp_push" : "poll";
		if (!state.selfAgentId) {
			await callRegister();
			return;
		}
		const res = await callHuddoraTool("agent_heartbeat", {
			extension_version: PLUGIN_VERSION,
			delivery_mode: mode,
		});
		if (res.ok) return;
		const msg = res.error.message.toLowerCase();
		if (msg.includes("revoked")) {
			persist({
				...state,
				selfAgentId: null,
				agentDisplayName: null,
				lastError: "agent revoked — open /account/agents",
			});
			return;
		}
		// Reconnect / process recycle: memory bind lost → re-register then retry heartbeat.
		if (msg.includes("agent_not_bound") || msg.includes("session")) {
			const ok = await callRegister();
			if (!ok) return;
			await callHuddoraTool("agent_heartbeat", {
				extension_version: PLUGIN_VERSION,
				delivery_mode: mode,
			});
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
		const res = await callHuddoraTool("room_watch", {
			room_id: state.roomId,
			after_cursor: state.cursor,
		});
		if (!res.ok) {
			delivery = "poll";
			return;
		}
		delivery = "notifications";
	}

	function schedulePoll(ctx: ExtensionContext, delayMs?: number) {
		if (timer) {
			ctx.clearTimer(timer);
			timer = null;
		}
		if (shutdown || !state.roomId || state.paused) return;
		const base = delivery === "notifications" ? Math.max(POLL_BASE_MS * 4, 30_000) : POLL_BASE_MS;
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
		const mode = await ensureHostMode();
		if (mode !== "host_manager") {
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
					persist(outcome.state);
				} else {
					persist(outcome.state);
				}
			} else if (outcome.kind === "empty" || outcome.kind === "error") {
				persist(outcome.state);
			}
		} catch (e) {
			persist(markError(state, e instanceof Error ? e.message : String(e)));
		} finally {
			inFlight = false;
			if (!shutdown && state.roomId && !state.paused) schedulePoll(ctx);
		}
	}

	async function syncNow(): Promise<string> {
		if (!state.roomId) return "No room selected. /huddora room <id>";
		const mode = await ensureHostMode();
		if (mode !== "host_manager") {
			return "Host MCP client unavailable. Ensure extension loads inside omp and MCPManager is set.";
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
		await ensureHostMode();
		const room = state.roomId ? `${state.roomName ?? "?"} (${state.roomId})` : "(none)";
		const pushLabel = !state.pushEnabled
			? "off (poll only)"
			: notifyHook?.mode === "sole_consumer"
				? "push (exclusive OMP notification slot)"
				: notifyHook?.mode === "chained_setOnNotification"
					? "push (chained)"
					: notifyHook?.mode === "onNotification"
						? "push (multi-subscriber)"
						: notifyHook?.installed
							? "push"
							: "off (not installed)";
		const lastPush =
			lastPushAt === null ? "never" : `${Math.max(0, Date.now() - lastPushAt)}ms ago`;
		return [
			`Huddora status`,
			`  plugin: v${PLUGIN_VERSION}`,
			`  delivery: ${delivery}`,
			`  push: ${pushLabel}`,
			`  push_mode: ${notifyHook?.mode ?? "none"}`,
			`  last_push_event: ${lastPush}`,
			`  host_mcp: ${hostMode}`,
			`  mcp: ${conn}`,
			`  room: ${room}`,
			`  cursor: ${state.cursor}`,
			`  paused: ${state.paused}`,
			`  self: ${state.selfDisplayName ?? "?"} (${state.selfUserId ?? "?"})`,
			`  agent_id: ${state.selfAgentId ?? "(not registered)"}`,
			`  agent_name: ${state.agentDisplayName ?? "—"}`,
			`  last_sync: ${state.lastSyncAt ?? "never"}`,
			`  last_error: ${state.lastError ?? "none"}`,
			`  notification_hook: ${notifyHook?.installed ?? false}`,
			`  sole_consumer: ${notifyHook?.clobberedUnknown ?? "n/a"}`,
			`  in_flight: ${inFlight}`,
			`  next_due_in_ms: ${timer ? Math.max(0, nextDueAt - Date.now()) : "n/a"}`,
			``,
			`Bus: notifications/huddora/messages (push) + safety poll (no model tools).`,
			`Inject: active=steer, idle=nextTurn+triggerTurn.`,
			`Auth: definition-only mcp.json + /mcp reauth huddora.`,
			`Compat: /huddora push on|off — default on uses OMP notification slot.`,
		].join("\n");
	}

	async function startDelivery(ctx: ExtensionContext) {
		liveCtx = ctx;
		if (!state.roomId || state.paused) return;
		const hooked = await hookNotifications(ctx);
		if (hooked) {
			await ensureWatch();
			await ensureAgentRegistered();
			scheduleHeartbeat(ctx);
			// Recovery poll; also detects silent SSE (no push activity).
			schedulePoll(ctx, 45_000);
			ctx.setTimeout(() => {
				if (
					!shutdown &&
					state.pushEnabled &&
					notifyHook?.installed &&
					state.roomId &&
					lastPushAt === null &&
					!state.paused
				) {
					// No exclusive security claim — just UX: recovery poll is active.
					ctx.ui.notify(
						"Huddora: live push armed; if chat is quiet, safety poll is still running.",
						"info",
					);
				}
			}, 60_000);
		} else {
			const mode = await ensureHostMode();
			delivery = mode === "host_manager" ? "poll" : "unavailable";
			if (mode === "host_manager") {
				await ensureAgentRegistered();
				scheduleHeartbeat(ctx);
				schedulePoll(ctx, 1_000);
			} else {
				ctx.ui.notify(
					"Huddora: host MCP client missing; cannot auto-deliver without model tools.",
					"error",
				);
			}
		}
	}

	pi.on("session_start", async (_e, ctx) => {
		shutdown = false;
		liveCtx = ctx;
		restore(ctx);
		await startDelivery(ctx);
		if (state.roomId) {
			ctx.ui.notify(
				`Huddora: ${state.roomName ?? state.roomId} [${delivery}]`,
				delivery === "unavailable" ? "error" : "info",
			);
		}
	});

	pi.on("session_switch", async (_e, ctx) => {
		liveCtx = ctx;
		restore(ctx);
		clearTimer(ctx);
		await startDelivery(ctx);
	});

	pi.on("session_branch", async (_e, ctx) => {
		liveCtx = ctx;
		restore(ctx);
		injectedCursors.clear();
		rateGuard = defaultRateGuard();
		clearTimer(ctx);
		await startDelivery(ctx);
	});

	pi.on("session_tree", async (_e, ctx) => {
		liveCtx = ctx;
		restore(ctx);
		clearTimer(ctx);
		await startDelivery(ctx);
	});

	pi.on("session_shutdown", async (_e, ctx) => {
		shutdown = true;
		flushPending(ctx);
		clearTimer(ctx);
		inFlight = false;
		liveCtx = null;
		if (state.roomId && hostMode === "host_manager") {
			void callHuddoraTool("room_unwatch", { room_id: state.roomId });
		}
		notifyHook?.restore();
		notifyHook = null;
	});

	pi.registerCommand("huddora", {
		description: "Huddora: connect|room|status|push|pause|resume|sync|disconnect",
		handler: async (args, ctx) => {
			liveCtx = ctx;
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] ?? "status").toLowerCase();
			const rest = parts.slice(1);

			switch (sub) {
				case "status":
				case "s":
					ctx.ui.notify(await statusText(), "info");
					return;
				case "connect": {
					await hookNotifications(ctx);
					const conn = await getHuddoraConnectionStatus();
					if (conn === "disconnected" || conn === "no_manager" || conn === "no_host_api") {
						ctx.ui.notify(
							`MCP not ready (${conn}). definition-only huddora + /mcp reauth huddora.`,
							"error",
						);
						return;
					}
					await ensureAgentRegistered();
					const rooms = await mcpRoomList();
					if (!rooms.ok) {
						ctx.ui.notify(`connect failed: ${rooms.error.message}`, "error");
						return;
					}
					if (rooms.data.length === 0) {
						ctx.ui.notify("Connected, no rooms. Join in browser, then /huddora room <id>.", "info");
						return;
					}
					ctx.ui.notify(
						`Rooms:\n${rooms.data.map((r) => `  ${r.room_id}  ${r.name}`).join("\n")}\n\n/huddora room <id>`,
						"info",
					);
					return;
				}
				case "room": {
					const roomId = rest[0];
					if (!roomId) {
						ctx.ui.notify("Usage: /huddora room <room_id>", "error");
						return;
					}
					const mode = await ensureHostMode();
					if (mode !== "host_manager") {
						ctx.ui.notify("Host MCP unavailable; cannot bind room for auto-delivery.", "error");
						return;
					}
					const boot = await bootstrapRoom(state, roomId);
					if (!boot.ok) {
						persist(boot.state);
						ctx.ui.notify(`room failed: ${boot.message}`, "error");
						return;
					}
					persist(boot.state);
					injectedCursors.clear();
					rateGuard = defaultRateGuard();
					await startDelivery(ctx);
					ctx.ui.notify(
						`Active: ${boot.state.roomName} cursor=${boot.state.cursor} [${delivery}]`,
						"info",
					);
					return;
				}
				case "push": {
					const arg = (rest[0] ?? "").toLowerCase();
					if (arg === "on" || arg === "1" || arg === "true") {
						persist({ ...state, pushEnabled: true });
						await startDelivery(ctx);
						ctx.ui.notify(
							`Push on [${delivery}] ${notifyHook?.mode === "sole_consumer" ? "(OMP notification slot)" : ""}`.trim(),
							"info",
						);
						return;
					}
					if (arg === "off" || arg === "0" || arg === "false") {
						notifyHook?.restore();
						notifyHook = null;
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
						`push=${state.pushEnabled ? "on" : "off"} mode=${notifyHook?.mode ?? "none"}. Usage: /huddora push on|off`,
						"info",
					);
					return;
				}
				case "pause":
					persist({ ...state, paused: true });
					clearTimer(ctx);
					if (state.roomId) void callHuddoraTool("room_unwatch", { room_id: state.roomId });
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
					if (state.roomId) void callHuddoraTool("room_unwatch", { room_id: state.roomId });
					persist(defaultState());
					injectedCursors.clear();
					rateGuard = defaultRateGuard();
					ctx.ui.notify("Disconnected.", "info");
					return;
				default:
					ctx.ui.notify(
						"Usage: /huddora connect|room|status|push on|off|pause|resume|sync|disconnect",
						"warning",
					);
			}
		},
	});
}

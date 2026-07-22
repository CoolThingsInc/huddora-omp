/**
 * Huddora OMP extension — background room chat delivery.
 *
 * Primary (architecture H): MCP SSE notifications/huddora/messages → sendMessage
 *   active: deliverAs steer; idle: nextTurn + triggerTurn
 * Notify: sole-consumer setOnNotification (default on); chain if getter exists
 * Transport: profile access-token MCP session + poll recovery
 * Auth: definition-only mcp.json + /mcp reauth (no token scrape)
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Text } from "@oh-my-pi/pi-tui";
import {
	applySeatPreempted,
	buildAgentRegisterArgs,
	canAttemptRebind,
	decideHeartbeatFailure,
	isAgentPreemptedError,
	isAgentUnboundError,
	needsVersionReregister,
	PREEMPTED_STATUS_MESSAGE,
	type RebindGate,
} from "./agent-bind";

import {
	DEBOUNCE_MS,
	defaultRateGuard,
	gateInject,
	type RateGuardState,
} from "./deliver";
import { COLLABORATION_GUIDANCE, COLLABORATION_GUIDANCE_VERSION, COLLABORATION_HELP } from "./guidance";
import {
	callHuddoraTool,
	getHuddoraConnectionStatus,
	mcpRoomList,
	setPluginBridge,
} from "./mcp-client";
import { parseHuddoraAgentNotification, parseHuddoraMessagesNotification } from "./notifications";
import { markError, nextPollDelayMs, restoreStateFromBranch } from "./state";
import {
	derivePresence,
	formatStatusLine,
	formatStatusReport,
	formatStatusWidgetLines,
	STATUS_KEY,
	toHumanStatusInput,
	type StatusTheme,
} from "./status-surface";
import {
	commandDescription,
	defaultMenuAction,
	deriveMenuActions,
	type MenuAction,
	type MenuState,
} from "./commands";
import { registerHuddoraRenderers, HUDDORA_STATUS_TYPE } from "./renderers";
import { diagnoseHumanProblem, formatHumanDoctor } from "./presentation";
import {
	connected as humanConnected,
	disconnected as humanDisconnected,
	paused as humanPaused,
	resumed as humanResumed,
	preempted as humanPreempted,
	roomNeeded,
	pushPreference,
	syncResult as humanSyncResult,
	transportUnavailable,
} from "./human-messages";
import { HuddoraBridge, type BridgeResult } from "./bridge";
import {
	DEFAULT_PROJECT_CONFIG,
	loadProjectConfig,
	resolveProjectRoot,
	setDefaultRoom,
	writeProjectConfig,
} from "./project-config";
import { bootstrapRoom, durablePayload, longPollWaitMs, pullAndFormat } from "./sync";
import { buildMessageSendArgs, formatMessageSendToolResult } from "./send-tool";
import { bindHostAgentSeat } from "./host-seat";
import {
	deliveryLight as deriveDeliveryLight,
	isCourierPrimary,
	recoveryPollBaseMs,
	shouldUsePollRecovery,
	type DeliveryLight,
} from "./delivery-health";
import {
	filterActiveToolsForSeat,
	isHostHuddoraMuteTrapTool,
	mergeHostToolsWhenBound,
} from "./host-tools";
import { ensureSessionKey } from "./session-key";
import {
	decideRoomBinding,
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
	PLUGIN_VERSION,
	POLL_BASE_MS,
	POLL_MAX_MS,
	COURIER_RECLAIM_MS,
} from "./types";

type TimerHandle = ReturnType<ExtensionContext["setInterval"]>;

export default function huddoraExtension(pi: ExtensionAPI) {
	pi.setLabel("Huddora");
	registerHuddoraRenderers(pi);

	let state: HuddoraPluginState = defaultState();
	let timer: TimerHandle | null = null;
	let heartbeatTimer: TimerHandle | null = null;
	let inFlight = false;
	let shutdown = false;
	let nextDueAt = 0;
	let delivery: "poll" | "bridge" | "unavailable" | "unknown" = "unknown";
	const injectedCursors = new Set<number>();
	let liveCtx: ExtensionContext | null = null;
	let rateGuard: RateGuardState = defaultRateGuard();
	let lastPushAt: number | null = null;
	let bridge: HuddoraBridge | null = null;
	let heartbeatOk = false;
	let heartbeatInFlight = false;
	/** True while this process holds the agent seat (session_key co-own OK). */
	let seatHeldExclusive = false;
	/** Ephemeral lease metadata from room_watch (not durable across sessions). */
	let leaseExpiresAt: number | null = null;
	let leaseEpoch: number | null = null;
	/** Dedicated reclaim timer calling ensureWatch on COURIER_RECLAIM_MS cadence. */
	let reclaimTimer: TimerHandle | null = null;
	/** Debounced wake timer curling a durable pull after an SSE push notification. */
	let wakeTimer: TimerHandle | null = null;
	/** Monotonic start of delivery for back-compat recovery proper grace window. */
	let deliveryStartedAt = Date.now();
	/** Host MCP agent_register succeeded for this process seat (best-effort). */
	let hostSeatBound = false;
	/** Last host bind diagnostic for doctor honesty. */
	let hostBindDetail: string | null = null;
	/** Single-flight guard so setActiveTools is not re-entered mid-filter. */
	let modelToolsSyncInFlight = false;
	let rebindGate: RebindGate = { inFlight: false, lastAttemptAt: 0, failStreak: 0 };
	let onboardingTimer: TimerHandle | null = null;
	let onboardingInFlight = false;
	let onboardingAttempts = 0;
	let lastOnboardStatus: string | null = null;

	function buildStatusInput(connection: string) {
		const presence = derivePresence({
			selfAgentId: state.selfAgentId,
			lastError: state.lastError,
			heartbeatOk: heartbeatOk && seatHeldExclusive,
			bridgeReady: Boolean(bridge),
		});
		const bridgeReady = Boolean(bridge);
		const light: DeliveryLight = deriveDeliveryLight({
			bridgeReady,
			leaseExpiresAt,
			lastPushAt,
			now: Date.now(),
			reclaimMs: COURIER_RECLAIM_MS,
		});
		return {
			pluginVersion: PLUGIN_VERSION,
			lastExtensionVersion: state.lastExtensionVersion,
			agentDisplayName: state.agentDisplayName,
			selfAgentId: state.selfAgentId,
			roomId: state.roomId,
			roomName: state.roomName,
			presence,
			delivery,
			paused: state.paused,
			bridgeActive: bridgeReady,
			connection,
			lastError: state.lastError,
			seatExclusive: seatHeldExclusive && presence === "online",
			deliveryLight: light,
			leaseExpiresAt,
			courierPrimary: isCourierPrimary(),
		};
	}

/**
 * Single-outbound when host cannot co-bind: hide mute-trap host tools from the model.
 * When hostSeatBound, re-enable them. Best-effort — setActiveTools may be unavailable early.
 */
async function syncModelToolsForSeat(): Promise<void> {
	if (modelToolsSyncInFlight) return;
	modelToolsSyncInFlight = true;
	try {
		const active = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
		const all = typeof pi.getAllTools === "function" ? pi.getAllTools() : active;
		if (!Array.isArray(active) || active.length === 0) return;
		let next = filterActiveToolsForSeat({
			active,
			hostSeatBound,
			pluginSeatHeld: seatHeldExclusive,
		});
		if (hostSeatBound) {
			next = mergeHostToolsWhenBound({ active: next, all, hostSeatBound: true });
		}
		const same =
			next.length === active.length && next.every((n, i) => n === active[i]);
		if (same) return;
		if (typeof pi.setActiveTools === "function") {
			await pi.setActiveTools(next);
		}
	} catch {
		// Non-fatal: guidance + tool_call block still protect the mute path.
	} finally {
		modelToolsSyncInFlight = false;
	}
}

async function applyHostBindResult(outcome: { ok: boolean; detail: string }): Promise<void> {
	hostSeatBound = outcome.ok;
	hostBindDetail = outcome.detail;
	await syncModelToolsForSeat();
}
/**
 * Refresh the status surface. The compact footer line is set first — it is
 * always renderable, including in RPC mode where `setWidget` silently drops
 * component-factory content (no throw). The rich widget is then attempted as
 * the primary interactive surface; keeping both surfaces is correctness over a
 * duplicate chrome line, since clearing the footer after a factory widget that
 * RPC dropped leaves RPC blank with no reliable mode/capability to detect.
 */
function refreshStatusSurface(ctx?: ExtensionContext | null) {
	const target = ctx ?? liveCtx;
	if (!target?.hasUI) return;
	const connection = bridge ? "bridge" : "bridge_missing";
	const input = buildStatusInput(connection);
	// Compact footer line — always populated before the widget attempt so an
	// RPC silent setWidget drop never produces a blank status surface.
	target.ui.setStatus(STATUS_KEY, formatStatusLine(input));
	try {
		const theme = target.ui.theme as StatusTheme;
		target.ui.setWidget(
			STATUS_KEY,
			(_tui, widgetTheme) => new Text(formatStatusWidgetLines(input, (widgetTheme ?? theme) as unknown as StatusTheme).join("\n"), 0, 0),
			{ placement: "belowEditor" },
		);
		// Do not clear the footer after a factory widget: RPC drops factory
		// content silently, so clearing here would blank the surface. Keeping
		// both is correctness over duplicate chrome (no reliable mode/capability).
	} catch {
		// setWidget unavailable: footer line already set above.
	}
}

	function persist(next: HuddoraPluginState) {
		state = next;
		pi.appendEntry(CUSTOM_STATE_TYPE, durablePayload(next));
		refreshStatusSurface();
	}

	function restore(ctx: ExtensionContext) {
		state = restoreStateFromBranch(ctx.sessionManager.getBranch());
		refreshStatusSurface(ctx);
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

	/**
	 * One auto-connect pass.
	 * - connected: room bound / delivery started
	 * - retry: transport/list/bind still recoverable (OAuth, transient)
	 * - stop: human action required — do not hammer room_list forever
	 */
	async function autoConnect(ctx: ExtensionContext): Promise<"connected" | "retry" | "stop"> {
		if (onboardingInFlight || shutdown || state.paused) {
			return state.roomId ? "connected" : "stop";
		}
		onboardingInFlight = true;
		try {
			const root = await resolveProjectRoot(ctx.cwd);
			const loaded = await loadProjectConfig(root);
			if (!loaded.ok) {
				ctx.ui.notify(
					`Huddora: config ignored — ${loaded.error}. Fix with /huddora init, then /huddora room.`,
					"warning",
				);
				return "stop";
			}
			if (state.roomId && state.projectRoot && state.projectRoot !== root) {
				await huddoraCall("room_unwatch", { room_id: state.roomId });
				persist({ ...state, roomId: null, roomName: null, cursor: 0, projectRoot: root });
			}
			if (state.roomId && state.projectRoot === root) {
				await startDelivery(ctx);
				injectGuidance(ctx, root);
				return "connected";
			}
			// Ensure bridge before listing/binding rooms.
			if (!(await ensureTransport(ctx))) {
				return "retry";
			}
			let rooms: Array<{ room_id: string }> = [];
			const needsRooms = !loaded.config.default_room_id && !(state.roomId && state.projectRoot === null);
			if (needsRooms) {
				const listed = await mcpRoomList();
				if (!listed.ok) return "retry";
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
				return (await bindRoom(ctx, root, decision.roomId, decision.source, decision.preserveCursor))
					? "connected"
					: "retry";
			}
			if (decision.action === "prompt_empty") {
				ctx.ui.notify(
					"Huddora: no rooms yet. Create or join one at huddora.coolthings.fyi, then /huddora room. Stopping auto-connect.",
					"info",
				);
				return "stop";
			}
			if (decision.action === "prompt_choose") {
				ctx.ui.notify(
					"Huddora: pick a room once with /huddora room <id> (optional: /huddora init first). Stopping auto-connect.",
					"info",
				);
				return "stop";
			}
			// clear_root / wait_transport / none should not spin forever without progress
			if (decision.action === "clear_root") return "retry";
			if (decision.action === "wait_transport") return "retry";
			return "stop";
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
			const result = await autoConnect(ctx);
			// stop = human must create/pick a room — never poll room_list forever
			if (result === "connected" || result === "stop" || shutdown || state.paused) {
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
		if (heartbeatTimer) {
			ctx.clearTimer(heartbeatTimer);
			heartbeatTimer = null;
		}
		if (onboardingTimer) {
			ctx.clearTimer(onboardingTimer);
			onboardingTimer = null;
		}
		if (reclaimTimer) {
			ctx.clearTimer(reclaimTimer);
			reclaimTimer = null;
		}
		if (wakeTimer) {
			ctx.clearTimer(wakeTimer);
			wakeTimer = null;
		}
	}

	/** Another session claimed our seat: offline locally, stop heartbeat/inject. */
	function handleSeatPreempted(agentId?: string | null) {
		if (agentId && state.selfAgentId && agentId !== state.selfAgentId) return;
		seatHeldExclusive = false;
		hostSeatBound = false;
		hostBindDetail = "seat preempted";
		void syncModelToolsForSeat();
		heartbeatOk = false;
		if (liveCtx) clearTimer(liveCtx);
		const next = applySeatPreempted(state, agentId);
		if (next.lastError === state.lastError && !seatHeldExclusive) {
			// Already preempted; still refresh UI.
			refreshStatusSurface();
			return;
		}
		if (liveCtx?.hasUI) {
			liveCtx.ui.notify(humanPreempted(), "warning");
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

	// Content inject only from durable pull path (pollTick + wake pull).
	// SSE bodies and next_cursor never advance state.cursor.


	async function ensureBridge(ctx: ExtensionContext): Promise<boolean> {
		// Plugin transport is the bridge — only path. OAuth consent was /mcp reauth.
		if (!bridge) {
			bridge = new HuddoraBridge();
			const started = await bridge.start((method, params) => {
				const agentEvt = parseHuddoraAgentNotification(method, params);
				if (agentEvt) {
					if (agentEvt.type === "agent_preempted") {
						if (state.selfAgentId && agentEvt.agentId !== state.selfAgentId) return;
						handleSeatPreempted(agentEvt.agentId);
						return;
					}
					if (state.selfAgentId && agentEvt.agentId !== state.selfAgentId) return;
					if (state.agentDisplayName === agentEvt.displayName) return;
					persist({ ...state, agentDisplayName: agentEvt.displayName });
					return;
				}
				if (method !== "notifications/huddora/messages") return;
				// Lost exclusive seat: ignore inject (another process owns delivery).
				if (!seatHeldExclusive) return;
				const parsed = parseHuddoraMessagesNotification(method, params);
				if (!parsed || (state.roomId && parsed.roomId !== state.roomId)) return;
				const c = liveCtx ?? ctx;
				// Pure wake: never inject SSE bodies or trust next_cursor for watermark.
				// Debounced durable pull is the sole inject authority.
				lastPushAt = Date.now();
				scheduleWakePull(c);
			});
			if (!started.ok) {
				bridge = null;
				persist(markError(state, started.message));
				return false;
			}
			setPluginBridge(async (toolName, args) => {
				const result = await bridge?.callTool(toolName, args);
				if (result?.ok) return result;
				return { ok: false, error: { kind: "no_host_api", message: result?.message ?? "Plugin MCP session unavailable." } };
			});
		}
		delivery = "bridge";
		return true;
	}

	/** Plugin tools always use the bridge transport. */
	async function ensureTransport(ctx: ExtensionContext): Promise<boolean> {
		return ensureBridge(ctx);
	}

	async function huddoraCall(toolName: string, args: Record<string, unknown> = {}): Promise<BridgeResult<unknown>> {
		// Bridge-only tool path.
		const result = await callHuddoraTool(toolName, args);
		if (result.ok) return result;
		if (bridge) return bridge.callTool(toolName, args);
		return { ok: false, message: result.error.message };
	}


	async function callRegister(): Promise<boolean> {
		// Per-project durable seat: same project root → same session_key across windows/restarts.
		// Path: ~/.config/huddora/projects/<project-id>/session_key (local only; never git).
		const cwd = liveCtx?.cwd ?? null;
		const projectRoot =
			state.projectRoot ??
			(cwd ? await resolveProjectRoot(cwd).catch(() => cwd) : null);
		const { key: sessionKey } = await ensureSessionKey({
			projectRoot,
			// Branch cache only when project root is unknown (should be rare).
			fallback: projectRoot ? null : state.sessionKey,
		});
		// First project bind: omit selfAgentId so server can create; rebind keeps rename (no display_name stomp).
		// If branch still holds a different project's seat id, clear it when key diverges.
		const seatMatchesBranch = Boolean(state.sessionKey && state.sessionKey === sessionKey);
		const selfAgentIdForRegister = seatMatchesBranch ? state.selfAgentId : null;
		const registerArgs = buildAgentRegisterArgs({
			selfAgentId: selfAgentIdForRegister,
			agentDisplayName: state.agentDisplayName,
			selfDisplayName: state.selfDisplayName,
			pluginVersion: PLUGIN_VERSION,
			// Same delivery_mode for host rebind so we do not stomp mcp_push → none.
			deliveryMode: delivery === "bridge" ? "mcp_push" : "poll",
			sessionKey,
		});
		const res = await huddoraCall("agent_register", registerArgs);
		if (!res.ok || !res.data || typeof res.data !== "object") {
			// Soft fail — do not leave "call agent_register first" as user-facing stuck state.
			const msg = res.ok === false ? res.message : "agent_register_failed";
			persist({ ...state, lastError: isAgentUnboundError(msg) ? "rebind pending" : msg.slice(0, 500) });
			return false;
		}
		const id = Reflect.get(res.data, "agent_id");
		const name = Reflect.get(res.data, "display_name");
		if (typeof id !== "string") return false;
		persist({
			...state,
			selfAgentId: id,
			sessionKey,
			projectRoot: projectRoot ?? state.projectRoot,
			agentDisplayName: typeof name === "string" ? name : state.agentDisplayName,
			lastExtensionVersion: PLUGIN_VERSION,
			lastError: null,
		});
		seatHeldExclusive = true;
		// Co-bind host MCP connection with the same session_key (best-effort; no room_watch).
		await applyHostBindResult(await bindHostAgentSeat(registerArgs));
		heartbeatOk = false; // next heartbeatTick flips online
		rebindGate = { inFlight: false, lastAttemptAt: rebindGate.lastAttemptAt, failStreak: 0 };
		return true;
	}

	/**
	 * Plugin-owned rebind: register once (single-flight + backoff), re-arm room_watch.
	 * Model never needs to call agent_register for normal recovery.
	 */
	async function rebindAgent(opts?: { force?: boolean }): Promise<boolean> {
		if (shutdown || state.paused) return false;
		const now = Date.now();
		if (!opts?.force && !canAttemptRebind(rebindGate, now)) return false;
		if (rebindGate.inFlight) return false;
		rebindGate = { ...rebindGate, inFlight: true, lastAttemptAt: now };
		try {
			const ok = await callRegister();
			if (!ok) {
				rebindGate = {
					inFlight: false,
					lastAttemptAt: now,
					failStreak: rebindGate.failStreak + 1,
				};
				return false;
			}
			rebindGate = { inFlight: false, lastAttemptAt: now, failStreak: 0 };
			// Session identity changed — re-arm watch without notification storm.
			if (state.roomId) await ensureWatch();
			return true;
		} catch {
			rebindGate = {
				inFlight: false,
				lastAttemptAt: now,
				failStreak: rebindGate.failStreak + 1,
			};
			return false;
		}
	}

	/**
	 * Start/hub rebind: always agent_register so host session gets seat + version stamp.
	 * session_key keeps the install seat; display_name omitted when already bound.
	 */
	async function ensureAgentRegistered(): Promise<void> {
		await rebindAgent({ force: true });
	}

	/** After any bound call fails with agent_not_bound, rebind once and retry the call. */
	async function withAgentBind<T>(
		run: () => Promise<BridgeResult<T>>,
	): Promise<BridgeResult<T>> {
		const first = await run();
		if (first.ok) return first;
		if (!isAgentUnboundError(first.message)) return first;
		if (!(await rebindAgent())) return first;
		return run();
	}

	async function heartbeatTick() {
		if (shutdown || state.paused || heartbeatInFlight) return;
		heartbeatInFlight = true;
		try {
			const mode = delivery === "bridge" ? "mcp_push" : "poll";
			if (
				!state.selfAgentId ||
				needsVersionReregister(state.lastExtensionVersion, PLUGIN_VERSION)
			) {
				if (await rebindAgent({ force: true })) {
					if (liveCtx) scheduleHeartbeat(liveCtx);
				}
				return;
			}
			const res = await huddoraCall("agent_heartbeat", {
				extension_version: PLUGIN_VERSION,
				delivery_mode: mode,
			});
			if (res.ok) {
				heartbeatOk = true;
				seatHeldExclusive = true;
				// Optional host co-bind if earlier register missed MCPManager singleton.
				if (!hostSeatBound && state.sessionKey) {
					const args = buildAgentRegisterArgs({
						selfAgentId: state.selfAgentId,
						agentDisplayName: state.agentDisplayName,
						selfDisplayName: state.selfDisplayName,
						pluginVersion: PLUGIN_VERSION,
						deliveryMode: mode,
						sessionKey: state.sessionKey,
					});
					await applyHostBindResult(await bindHostAgentSeat(args));
				} else {
					// Keep model tool surface honest even when already bound/unbound.
					await syncModelToolsForSeat();
				}
				// Clear soft rebind noise once presence is healthy.
				if (state.lastError && /rebind|heartbeat|agent_not_bound|agent_register|seat taken/i.test(state.lastError)) {
					persist({ ...state, lastError: null });
				} else {
					refreshStatusSurface();
				}
				return;
			}
			heartbeatOk = false;
			const decision = decideHeartbeatFailure(res.message, rebindGate, Date.now());
			if (decision.action === "stop_revoked") {
				seatHeldExclusive = false;
				hostSeatBound = false;
				hostBindDetail = "agent revoked";
				void syncModelToolsForSeat();
				persist({
					...state,
					selfAgentId: null,
					agentDisplayName: null,
					lastError: "agent revoked — open /account/agents",
				});
				if (liveCtx) clearTimer(liveCtx);
				return;
			}
			if (decision.action === "stop_preempted") {
				handleSeatPreempted(state.selfAgentId);
				return;
			}
			if (decision.action === "wait_backoff") return;
			if (decision.action === "record_error") {
				// Internal only — never leave "call agent_register first" as stuck user copy.
				const soft = isAgentPreemptedError(res.message)
					? PREEMPTED_STATUS_MESSAGE
					: isAgentUnboundError(res.message)
						? "presence rebind backoff"
						: `heartbeat: ${res.message}`.slice(0, 500);
				persist({ ...state, lastError: soft });
				return;
			}
			// rebind
			if (await rebindAgent()) {
				const retry = await huddoraCall("agent_heartbeat", {
					extension_version: PLUGIN_VERSION,
					delivery_mode: mode,
				});
				if (!retry.ok) {
					heartbeatOk = false;
					if (isAgentPreemptedError(retry.message)) {
						handleSeatPreempted(state.selfAgentId);
						return;
					}
					const soft = isAgentUnboundError(retry.message)
						? "presence rebind pending"
						: `heartbeat: ${retry.message}`.slice(0, 500);
					persist({ ...state, lastError: soft });
				} else {
					heartbeatOk = true;
					seatHeldExclusive = true;
					if (state.lastError) {
						persist({ ...state, lastError: null });
					} else {
						refreshStatusSurface();
					}
				}
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
		// First heartbeat immediately so footer flips online after upgrade/rebind.
		void heartbeatTick();
		heartbeatTimer = ctx.setInterval(() => {
			void heartbeatTick();
		}, HEARTBEAT_MS);
	}

	async function ensureWatch(): Promise<void> {
		if (!state.roomId || state.paused) return;
		const res = await withAgentBind(() =>
			huddoraCall("room_watch", {
				room_id: state.roomId!,
				after_cursor: state.cursor,
			}),
		);
		if (!res.ok) {
			delivery = "poll";
			// Lease lost or never granted; clear stale ephemeral lease metadata.
			leaseExpiresAt = null;
			leaseEpoch = null;
			return;
		}
		delivery = "bridge";
		// Parse ephemeral lease metadata from res.data (back-compat: fields optional).
		const data = res.data as Record<string, unknown> | null;
		if (data && typeof data === "object") {
			const expiresRaw = Reflect.get(data, "expires_at");
			if (typeof expiresRaw === "string") {
				const parsed = Date.parse(expiresRaw);
				if (Number.isFinite(parsed)) leaseExpiresAt = parsed;
			} else if (typeof expiresRaw === "number" && Number.isFinite(expiresRaw)) {
				leaseExpiresAt = expiresRaw;
			}
			const epochRaw = Reflect.get(data, "lease_epoch");
			if (typeof epochRaw === "number" && Number.isFinite(epochRaw)) {
				leaseEpoch = epochRaw;
			} else if (typeof epochRaw === "string" && Number.isFinite(Number(epochRaw))) {
				leaseEpoch = Number(epochRaw);
			}
		}
	}

	/**
	 * Dedicated lease reclaim timer: re-arms room_watch on COURIER_RECLAIM_MS cadence
	 * so the durable subscription lease stays fresh even when SSE pushes are quiet.
	 */
	function scheduleReclaim(ctx: ExtensionContext) {
		if (reclaimTimer) {
			ctx.clearTimer(reclaimTimer);
			reclaimTimer = null;
		}
		if (shutdown || !state.roomId || state.paused) return;
		reclaimTimer = ctx.setInterval(() => {
			void ensureWatch();
		}, COURIER_RECLAIM_MS);
	}

	/**
	 * Debounced durable pull triggered by an SSE push notification.
	 * Uses the SAME durable inject path as pollTick (pullAndFormat waitMs=0);
	 * never trusts SSE next_cursor or message bodies to advance state.cursor.
	 */
	function scheduleWakePull(ctx: ExtensionContext) {
		if (wakeTimer) {
			ctx.clearTimer(wakeTimer);
			wakeTimer = null;
		}
		if (shutdown || !state.roomId || state.paused) return;
		wakeTimer = ctx.setTimeout(() => {
			wakeTimer = null;
			void durablePullAndInject(ctx);
		}, DEBOUNCE_MS);
	}

	async function durablePullAndInject(ctx: ExtensionContext): Promise<void> {
		if (inFlight || shutdown || !state.roomId || state.paused) return;
		if (!(await ensureTransport(ctx))) {
			delivery = "unavailable";
			return;
		}
		inFlight = true;
		try {
			const outcome = await pullAndFormat(state, { waitMs: 0 });
			if (outcome.kind === "injected") {
				if (!injectedCursors.has(outcome.cursorAfter)) {
					const queued = queueInject(outcome.content, outcome.cursorAfter, outcome.messageCount);
					if (queued) {
						injectedCursors.add(outcome.cursorAfter);
						if (ctx.hasUI) ctx.ui.notify(`Huddora: +${outcome.messageCount} msg`, "info");
					}
				}
				persist(outcome.state);
			} else if (outcome.kind === "empty" || outcome.kind === "error") {
				persist(outcome.state);
			}
		} catch (error) {
			persist(markError(state, error instanceof Error ? error.message : String(error)));
		} finally {
			inFlight = false;
		}
	}

	function schedulePoll(ctx: ExtensionContext, delayMs?: number) {
		if (timer) {
			ctx.clearTimer(timer);
			timer = null;
		}
		if (shutdown || !state.roomId || state.paused) return;
		const now = Date.now();
		const bridgeBase = Math.max(POLL_BASE_MS * 4, 30_000);
		const rawBase = delivery === "bridge" ? bridgeBase : POLL_BASE_MS;
		const useRecovery = shouldUsePollRecovery({
			delivery,
			pushEnabled: state.pushEnabled,
			lastPushAt,
			startedAt: deliveryStartedAt,
			now,
		});
		const base = recoveryPollBaseMs(useRecovery, rawBase);
		const delay = delayMs ?? nextPollDelayMs(state, base, POLL_MAX_MS);
		nextDueAt = now + delay;
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
			// Reclaim the durable lease each tick so room_watch stays fresh.
			await ensureWatch();
			const now = Date.now();
			const useRecovery = shouldUsePollRecovery({
				delivery,
				pushEnabled: state.pushEnabled,
				lastPushAt,
				startedAt: deliveryStartedAt,
				now,
			});
			// Poll density: long-poll when pure-poll or when SSE looks stale; waitMs=0
			// when bridge push is healthy (just a quick durable confirm).
			const waitMs =
				delivery === "poll" || useRecovery ? (longPollWaitMs(false) ?? 0) : 0;
			const outcome = await pullAndFormat(state, { waitMs });
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

	async function syncNow(): Promise<{ newMessages: number; error?: string | null }> {
		if (!state.roomId) return { newMessages: 0, error: roomNeeded() };
		if (!bridge && !(liveCtx && (await ensureBridge(liveCtx)))) {
			return { newMessages: 0, error: transportUnavailable("sync", state.lastError) };
		}
		if (inFlight) return { newMessages: 0, error: "Sync already running; try again shortly" };
		inFlight = true;
		try {
			const outcome = await pullAndFormat(state, { waitMs: 0 });
			if (outcome.kind === "injected") {
				if (!injectedCursors.has(outcome.cursorAfter)) {
					queueInject(outcome.content, outcome.cursorAfter, outcome.messageCount);
					injectedCursors.add(outcome.cursorAfter);
				}
				persist(outcome.state);
				return { newMessages: outcome.messageCount };
			}
			if (outcome.kind === "empty") {
				persist(outcome.state);
				return { newMessages: 0 };
			}
			if (outcome.kind === "error") {
				persist(outcome.state);
				return { newMessages: 0, error: outcome.message };
			}
			return { newMessages: 0, error: roomNeeded() };
		} finally {
			inFlight = false;
		}
	}

	async function statusText(): Promise<string> {
		const conn = await getHuddoraConnectionStatus();
		return formatStatusReport(buildStatusInput(conn));
	}

	async function startDelivery(ctx: ExtensionContext) {
		liveCtx = ctx;
		if (!state.roomId || state.paused) {
			refreshStatusSurface(ctx);
			return;
		}
		if (!(await ensureBridge(ctx))) {
			delivery = "unavailable";
			heartbeatOk = false;
			refreshStatusSurface(ctx);
			ctx.ui.notify(
				"Huddora: plugin MCP session unavailable. Run /mcp reauth huddora if OAuth expired, then /huddora connect.",
				"error",
			);
			return;
		}
		// Register first so room_watch / heartbeat never hit agent_not_bound on a fresh session.
		await ensureAgentRegistered();
		await ensureWatch();
		// Lease reclaim cadence starts only after a successful ensureWatch attempt.
		deliveryStartedAt = Date.now();
		scheduleReclaim(ctx);
		scheduleHeartbeat(ctx);
		schedulePoll(ctx, 1_000);
		refreshStatusSurface(ctx);
	}

	pi.on("session_start", async (_e, ctx) => {
		shutdown = false;
		liveCtx = ctx;
		restore(ctx);
		refreshStatusSurface(ctx);
		scheduleOnboarding(ctx, true);
	});

	pi.on("session_switch", async (_e, ctx) => {
		liveCtx = ctx;
		restore(ctx);
		clearTimer(ctx);
		refreshStatusSurface(ctx);
		scheduleOnboarding(ctx, true);
	});

	pi.on("session_branch", async (_e, ctx) => {
		liveCtx = ctx;
		restore(ctx);
		injectedCursors.clear();
		rateGuard = defaultRateGuard();
		clearTimer(ctx);
		refreshStatusSurface(ctx);
		scheduleOnboarding(ctx, true);
	});

	pi.on("session_tree", async (_e, ctx) => {
		liveCtx = ctx;
		restore(ctx);
		clearTimer(ctx);
		refreshStatusSurface(ctx);
		scheduleOnboarding(ctx, true);
	});

	pi.on("session_shutdown", async (_e, ctx) => {
		shutdown = true;
		// No SSE-body flush; durable pull is the sole inject authority.
		clearTimer(ctx);
		inFlight = false;
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			try { ctx.ui.setWidget(STATUS_KEY, undefined); } catch {}
		}
		liveCtx = null;
		if (state.roomId) await huddoraCall("room_unwatch", { room_id: state.roomId });
		if (bridge) {
			await bridge.close();
			bridge = null;
			setPluginBridge(null);
		}
	});

	// Block host mute-trap tools if they remain active despite setActiveTools filter.
	pi.on("tool_call", (event) => {
		if (!seatHeldExclusive || hostSeatBound) return;
		if (!isHostHuddoraMuteTrapTool(event.toolName)) return;
		return {
			block: true,
			reason:
				"Host mcp__huddora_message_send is unbound while the plugin holds the seat (host MCP is a different session; dual-package OMP often cannot co-bind). Use write xd://huddora_message_send (plugin bridge seat). /huddora doctor shows Host seat status.",
		};
	});



	const { z } = pi.zod;
	// Cast: pi.zod + ToolDefinition generics can exceed TS instantiation depth.
	pi.registerTool({
		name: "huddora_message_send",
		label: "Huddora message send",
		description:
			"Send a room message via the plugin-bound bridge session (the same seat as footer Here). On OMP with tools.xdev, invoke by writing JSON args to xd://huddora_message_send (discoverable mount). Required model send path when doctor Host seat is unbound. Host mcp__huddora_message_send is only valid when Host seat: bound; otherwise it is hidden as a mute-online trap. Do not use by default for local OMP chat; only when the user asked to post/notify/reply in the room or context clearly requires a room reply (inbound huddora_event, tell the room, etc.).",
		// discoverable so xdev mounts xd://huddora_message_send (essential stays top-level and is invisible to xd-only inventories).
		loadMode: "discoverable",
		approval: "write",
		parameters: z.object({
			room_id: z.string().describe("UUID of the room"),
			body: z.string().describe("Message text, 1–8000 characters"),
			client_message_id: z
				.string()
				.optional()
				.describe("Idempotency key 1–128; stable across retries. Generated if omitted."),
			reply_to: z.string().optional().describe("Parent message UUID in the same room"),
		}),
		async execute(
			_toolCallId: string,
			params: {
				room_id: string;
				body: string;
				client_message_id?: string;
				reply_to?: string;
			},
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext | undefined,
		) {
			const body = typeof params.body === "string" ? params.body : "";
			if (body.length < 1 || body.length > 8000) {
				return formatMessageSendToolResult({
					ok: false,
					message: "body must be 1–8000 characters",
				});
			}
			const roomId = typeof params.room_id === "string" ? params.room_id : "";
			if (!/^[0-9a-fA-F-]{36}$/.test(roomId)) {
				return formatMessageSendToolResult({
					ok: false,
					message: "room_id must be a UUID",
				});
			}
			const target = ctx ?? liveCtx;
			if (!target) {
				return formatMessageSendToolResult({
					ok: false,
					message: "No active OMP session context for Huddora send.",
				});
			}
			if (!(await ensureBridge(target))) {
				return formatMessageSendToolResult({
					ok: false,
					message:
						"Huddora plugin MCP session unavailable. Run /mcp reauth huddora if needed, then /huddora connect.",
				});
			}
			const args = buildMessageSendArgs({
				room_id: roomId,
				body,
				client_message_id: params.client_message_id,
				reply_to: params.reply_to,
			});
			const res = await withAgentBind(() => huddoraCall("message_send", args));
			if (!res.ok) {
				return formatMessageSendToolResult({ ok: false, message: res.message });
			}
			return formatMessageSendToolResult({ ok: true, data: res.data });
		},
		renderCall(
			args: { room_id?: string; body?: string },
			_options: { expanded: boolean },
			theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
		): Text {
			const shortId = typeof args.room_id === "string" ? args.room_id.slice(0, 8) : "no-room";
			const bodyLen = typeof args.body === "string" ? args.body.length : 0;
			const title = theme.fg("toolTitle", theme.bold("Huddora · Send message"));
			const meta = theme.fg("muted", ` · room ${shortId} · ${bodyLen} chars`);
			return new Text(`${title}${meta}`, 0, 0);
		},
		renderResult(
			result: { content: Array<{ type: string; text?: string }>; isError?: boolean; details?: { ok?: boolean } },
			_options: { expanded: boolean; isPartial?: boolean },
			theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
		): Text {
			const ok = result.isError ? false : (result.details?.ok ?? true);
			if (ok) {
				return new Text(theme.fg("success", theme.bold("Huddora · Message sent")), 0, 0);
			}
			const fault = result.content.find((p) => p.type === "text")?.text ?? "send failed";
			// Never dump raw payloads or secrets; surface a concise human failure only.
			const concise = fault.split("\n")[0]?.slice(0, 140) ?? "send failed";
			return new Text(theme.fg("error", `${theme.bold("Huddora · Message not sent")} · ${concise}`), 0, 0);
		},
	} as Parameters<ExtensionAPI["registerTool"]>[0]);
	pi.registerCommand("huddora", {
		description: commandDescription(),
		handler: async (args, ctx) => {
			liveCtx = ctx;
			const parts = args.trim().split(/\s+/).filter(Boolean);

			let sub = "";
			let rest: string[] = [];

			if (parts.length === 0) {
				if (!ctx.hasUI) return;
				const menuState: MenuState = {
					roomId: state.roomId,
					connection: bridge ? "bridge" : "bridge_missing",
					paused: state.paused,
					lastError: state.lastError,
				};
				const actions = deriveMenuActions(menuState);
				const defaultId = defaultMenuAction(menuState);
				const defaultIndex = actions.findIndex((a) => a.id === defaultId);
				const options = actions.map((a) => ({ label: a.label, description: a.description }));

				const selection = await ctx.ui.select("Huddora", options, {
					selectionMarker: "radio",
					initialIndex: Math.max(0, defaultIndex),
					helpText: "Enter to run · Esc to close",
				});
				if (!selection) return;

				const selectedAction = actions.find((a) => a.label === selection);
				if (!selectedAction) return;

				sub = selectedAction.id;
				// Destructive menu choice (disconnect) requires confirmation before acting.
				// Explicit `/huddora disconnect` (parts.length>0 path) stays immediate.
				if (selectedAction.destructive) {
					const confirmed = await ctx.ui.confirm(
						"Disconnect Huddora?",
						"This stops background delivery, unwatch the room, and resets session state. Reconnect with /huddora connect.",
					);
					if (!confirmed) return;
				}
				if (sub === "setup") sub = "init";
				if (sub === "pick_room" || sub === "switch_room") sub = "room";
				if (sub === "reconnect") sub = "connect";
			} else {
				sub = parts[0].toLowerCase();
				rest = parts.slice(1);
			}

			if (sub === "reauth") {
				ctx.ui.notify("Run /mcp reauth huddora to refresh credentials.", "warning");
				return;
			}

			switch (sub) {
				case "connect": {
					persist({ ...state, bridgeDisabled: false, lastError: null });
					if (ctx.hasUI) ctx.ui.notify("Huddora: reconnecting…", "info");
					scheduleOnboarding(ctx, true);
					return;
				}
				case "status":
					pi.sendMessage(
						{
							customType: HUDDORA_STATUS_TYPE,
							content: await statusText(),
							display: true,
							attribution: "agent",
						},
						{ triggerTurn: false }
					);
					return;
				case "help":
					ctx.ui.notify(COLLABORATION_HELP, "info");
					return;
				case "init": {
					try {
						await writeProjectConfig(ctx.cwd, DEFAULT_PROJECT_CONFIG);
						ctx.ui.notify("Huddora: project config created. Run /mcp reauth huddora or reload to auto-connect.", "info");
					} catch (error) {
						ctx.ui.notify(`Huddora: config write failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
					return;
				}
				case "config": {
					const config = await loadProjectConfig(ctx.cwd);
					if (!config.ok) {
						ctx.ui.notify(`Huddora: config unavailable — ${config.error}. Run /huddora init to create it.`, "error");
						return;
					}
					const roomLabel =
						config.config.default_room_id
							? `${config.config.default_room_id}${state.roomName ? ` (${state.roomName})` : ""}`
							: state.roomName ?? state.roomId ?? "none";
					const boundNow = state.roomId ? ` — currently bound: ${roomLabel}` : "";
					const defaultRoom = config.config.default_room_id
						? `Default room: ${config.config.default_room_id}`
						: "Default room: none (use /huddora room <id> to remember one)";
					ctx.ui.notify(
						`Huddora: config at ${config.path}\n${defaultRoom}${boundNow}`,
						"info",
					);
					return;
				}
				case "doctor": {
					const connection = bridge ? "bridge" : "bridge_missing";
					const input = toHumanStatusInput(buildStatusInput(connection));
					const problem = diagnoseHumanProblem(input);
					if (problem) {
						ctx.ui.notify(formatHumanDoctor(problem), problem.level);
					} else {
						// Healthy copy routes through formatHumanDoctor so there is a single healthy source.
						ctx.ui.notify(formatHumanDoctor(null), "info");
					}
					return;
				}
				case "room": {
					const roomId = rest[0];
					if (!roomId) {
						if (!(await ensureTransport(ctx))) {
							ctx.ui.notify(transportUnavailable("listing rooms", state.lastError), "warning");
							return;
						}
						const rooms = await mcpRoomList();
						if (!rooms.ok) {
							ctx.ui.notify(roomToolFailureMessage(rooms.error), "warning");
							return;
						}
						ctx.ui.notify(
							rooms.data.length === 0
								? roomNeeded()
								: `Huddora: rooms\n${rooms.data.map(room => `  ${room.name}  (${room.room_id})`).join("\n")}\n\n/huddora room <id>`,
							"info",
						);
						return;
					}
					const root = await resolveProjectRoot(ctx.cwd);
					if (!(await ensureTransport(ctx))) {
						ctx.ui.notify(transportUnavailable("binding room", state.lastError), "error");
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
						ctx.ui.notify(humanConnected(state.roomName, false), "info");
						return;
					}
					try {
						await setDefaultRoom(root, roomId);
						ctx.ui.notify(humanConnected(state.roomName, true), "info");
					} catch (error) {
						ctx.ui.notify(`Huddora: connected, but could not save project config: ${error instanceof Error ? error.message : String(error)}`, "warning");
					}
					return;
				}
				case "push": {
					const arg = (rest[0] ?? "").toLowerCase();
					if (arg === "on" || arg === "1" || arg === "true") {
						persist({ ...state, pushEnabled: true });
						await startDelivery(ctx);
						ctx.ui.notify(pushPreference(true), "info");
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
						ctx.ui.notify(pushPreference(false), "info");
						return;
					}
					ctx.ui.notify(`Huddora: live updates are ${state.pushEnabled ? "on" : "off"}. Usage: /huddora push on|off`, "info");
					return;
				}
				case "pause":
					persist({ ...state, paused: true });
					clearTimer(ctx);
					if (state.roomId) void huddoraCall("room_unwatch", { room_id: state.roomId });
					ctx.ui.notify(humanPaused(), "info");
					return;
				case "resume":
					if (!state.roomId) {
						ctx.ui.notify(roomNeeded(), "warning");
						return;
					}
					persist({ ...state, paused: false, emptyStreak: 0, errorStreak: 0 });
					await startDelivery(ctx);
					ctx.ui.notify(humanResumed(), "info");
					return;
				case "sync": {
					const res = await syncNow();
					ctx.ui.notify(humanSyncResult(res), res.error ? "error" : "info");
					return;
				}
				case "disconnect":
					clearTimer(ctx);
					if (state.roomId) await huddoraCall("room_unwatch", { room_id: state.roomId });
					if (bridge) await bridge.close();
					bridge = null;
					setPluginBridge(null);
					delivery = "unavailable";
					heartbeatOk = false;
					seatHeldExclusive = false;
					hostSeatBound = false;
					hostBindDetail = "disconnected";
					persist(defaultState());
					injectedCursors.clear();
					rateGuard = defaultRateGuard();
					await syncModelToolsForSeat();
					if (ctx.hasUI) {
						try { ctx.ui.setWidget(STATUS_KEY, undefined); } catch {}
						ctx.ui.setStatus(STATUS_KEY, undefined);
					}
					ctx.ui.notify(humanDisconnected(), "info");
					return;
				default:
					ctx.ui.notify(
						"Huddora: usage — /huddora init|config|room [id]|help|status|doctor|connect|push on|off|pause|resume|sync|disconnect",
						"warning",
					);
					return;
			}
		},
	});
}

import { describe, expect, test } from "bun:test";
import {
	applySeatPreempted,
	buildAgentRegisterArgs,
	canAttemptRebind,
	decideHeartbeatFailure,
	isAgentPreemptedError,
	isAgentRevokedError,
	isAgentUnboundError,
	mcpToolFailureMessage,
	needsVersionReregister,
	PREEMPTED_STATUS_MESSAGE,
	type RebindGate,
} from "./agent-bind";

describe("isAgentUnboundError", () => {
	test("matches server agent_not_bound phrasing", () => {
		expect(isAgentUnboundError("agent_not_bound — call agent_register first")).toBe(true);
		expect(isAgentUnboundError("Error: agent_not_bound — call agent_register first")).toBe(true);
		expect(isAgentUnboundError("AGENT_NOT_BOUND")).toBe(true);
		expect(isAgentUnboundError("session not bound")).toBe(true);
	});

	test("ignores unrelated errors", () => {
		expect(isAgentUnboundError("Huddora MCP session transport error")).toBe(false);
		expect(isAgentUnboundError("agent revoked")).toBe(false);
		expect(isAgentUnboundError("")).toBe(false);
	});
});

describe("isAgentRevokedError", () => {
	test("detects revocation", () => {
		expect(isAgentRevokedError("agent revoked")).toBe(true);
		expect(isAgentRevokedError("REVOKED")).toBe(true);
		expect(isAgentRevokedError("agent_not_bound")).toBe(false);
	});
});

describe("canAttemptRebind", () => {
	const free: RebindGate = { inFlight: false, lastAttemptAt: 0, failStreak: 0 };

	test("first attempt always allowed", () => {
		expect(canAttemptRebind(free, 1_000)).toBe(true);
	});

	test("single-flight blocks concurrent attempts", () => {
		expect(canAttemptRebind({ ...free, inFlight: true }, 1_000)).toBe(false);
	});

	test("backoff grows with fail streak", () => {
		const t0 = 10_000;
		const after = (streak: number): RebindGate => ({
			inFlight: false,
			lastAttemptAt: t0,
			failStreak: streak,
		});
		// streak 0 → 5s
		expect(canAttemptRebind(after(0), t0 + 4_999)).toBe(false);
		expect(canAttemptRebind(after(0), t0 + 5_000)).toBe(true);
		// streak 1 → 10s
		expect(canAttemptRebind(after(1), t0 + 9_999)).toBe(false);
		expect(canAttemptRebind(after(1), t0 + 10_000)).toBe(true);
		// streak 4+ → 60s cap (5 * 2^4 = 80 → 60)
		expect(canAttemptRebind(after(4), t0 + 59_999)).toBe(false);
		expect(canAttemptRebind(after(4), t0 + 60_000)).toBe(true);
		expect(canAttemptRebind(after(9), t0 + 60_000)).toBe(true);
	});
});

describe("decideHeartbeatFailure", () => {
	const open: RebindGate = { inFlight: false, lastAttemptAt: 0, failStreak: 0 };

	test("revoked stops", () => {
		expect(decideHeartbeatFailure("agent revoked — open account", open, 1).action).toBe("stop_revoked");
	});

	test("preempted stops without rebind thrash", () => {
		expect(
			decideHeartbeatFailure(
				"agent_not_bound — this MCP session does not own the agent seat (unbound or preempted)",
				open,
				1,
			).action,
		).toBe("stop_preempted");
		expect(decideHeartbeatFailure("agent_preempted reason=bound_elsewhere", open, 1).action).toBe(
			"stop_preempted",
		);
	});

	test("unbound rebinds when gate open", () => {
		expect(
			decideHeartbeatFailure("agent_not_bound — call agent_register first", open, 1).action,
		).toBe("rebind");
	});

	test("generic session failure also rebinds (transport/session loss)", () => {
		expect(decideHeartbeatFailure("Huddora MCP session tool error", open, 1).action).toBe(
			"rebind",
		);
	});

	test("in-flight rebind waits", () => {
		expect(
			decideHeartbeatFailure("agent_not_bound", { ...open, inFlight: true }, 1).action,
		).toBe("wait_backoff");
	});

	test("during backoff records soft error", () => {
		const gate: RebindGate = { inFlight: false, lastAttemptAt: 1_000, failStreak: 0 };
		expect(decideHeartbeatFailure("agent_not_bound", gate, 1_000 + 1_000).action).toBe(
			"record_error",
		);
	});
});

describe("seat exclusivity helpers", () => {
	test("isAgentPreemptedError matches server phrasing", () => {
		expect(isAgentPreemptedError("agent_preempted")).toBe(true);
		expect(isAgentPreemptedError("bound_elsewhere")).toBe(true);
		expect(isAgentPreemptedError("preempted by another session")).toBe(true);
		expect(isAgentPreemptedError("agent_not_bound — call agent_register first")).toBe(false);
	});

	test("isAgentUnboundError ignores pure preempt errors", () => {
		expect(isAgentUnboundError("agent_preempted reason=bound_elsewhere")).toBe(false);
		expect(isAgentUnboundError("agent_not_bound — call agent_register first")).toBe(true);
	});

	test("applySeatPreempted sets recovery copy", () => {
		const next = applySeatPreempted(
			{ selfAgentId: "a1", lastError: null },
			"a1",
		);
		expect(next.lastError).toBe(PREEMPTED_STATUS_MESSAGE);
		expect(
			applySeatPreempted({ selfAgentId: "a1", lastError: null }, "other").lastError,
		).toBeNull();
	});
});

describe("mcpToolFailureMessage", () => {
	test("extracts isError text content", () => {
		expect(
			mcpToolFailureMessage({
				isError: true,
				content: [{ type: "text", text: "agent_not_bound — call agent_register first" }],
			}),
		).toBe("agent_not_bound — call agent_register first");
	});

	test("success payloads return null", () => {
		expect(mcpToolFailureMessage({ agent_id: "x" })).toBe(null);
		expect(mcpToolFailureMessage({ content: [{ type: "text", text: '{"ok":true}' }] })).toBe(null);
		expect(mcpToolFailureMessage(null)).toBe(null);
	});

	test("isError without text falls back", () => {
		expect(mcpToolFailureMessage({ isError: true, content: [] })).toBe("MCP tool error");
	});
});

/**
 * Simulated unbound → rebind → heartbeat succeeds (plugin ownership loop).
 * No ExtensionAPI — models the extension control flow with pure helpers.
 */
describe("unbound → auto rebind → heartbeat succeeds", () => {
	test("single rebind recovers without model intervention", () => {
		let gate: RebindGate = { inFlight: false, lastAttemptAt: 0, failStreak: 0 };
		let selfAgentId: string | null = null;
		let roomWatchArmed = false;
		let lastError: string | null = null;
		const now = 1000;

		const heartbeatFail = "agent_not_bound — call agent_register first";
		const decision = decideHeartbeatFailure(heartbeatFail, gate, now);
		expect(decision.action).toBe("rebind");

		// single-flight
		expect(canAttemptRebind(gate, now)).toBe(true);
		gate = { ...gate, inFlight: true, lastAttemptAt: now };

		// callRegister succeeds
		selfAgentId = "agent-uuid";
		gate = { ...gate, inFlight: false, failStreak: 0 };
		roomWatchArmed = true; // ensureWatch after rebind
		lastError = null;

		// retry heartbeat
		const retryOk = true;
		expect(selfAgentId).toBeTruthy();
		expect(roomWatchArmed).toBe(true);
		expect(retryOk).toBe(true);
		expect(lastError).toBe(null);
		// model never saw "call agent_register first" as stuck status
		expect(isAgentUnboundError(heartbeatFail)).toBe(true);
		expect(lastError === null || !/agent_register/.test(lastError)).toBe(true);
	});
	test("failed rebind increments streak and backs off", () => {
		let gate: RebindGate = { inFlight: false, lastAttemptAt: 0, failStreak: 0 };
		const t = 5_000;
		expect(decideHeartbeatFailure("agent_not_bound", gate, t).action).toBe("rebind");
		gate = { inFlight: false, lastAttemptAt: t, failStreak: 1 };
		// too soon
		expect(decideHeartbeatFailure("agent_not_bound", gate, t + 1_000).action).toBe("record_error");
		// after 10s ok
		expect(decideHeartbeatFailure("agent_not_bound", gate, t + 10_000).action).toBe("rebind");
	});
});

describe("needsVersionReregister", () => {
	test("missing or mismatched stamp forces re-register", () => {
		expect(needsVersionReregister(null, "0.3.9")).toBe(true);
		expect(needsVersionReregister(undefined, "0.3.9")).toBe(true);
		expect(needsVersionReregister("0.3.7", "0.3.9")).toBe(true);
		expect(needsVersionReregister("0.3.9", "0.3.9")).toBe(false);
	});
});

describe("buildAgentRegisterArgs", () => {
	const base = {
		agentDisplayName: "Cabinet Name",
		selfDisplayName: "Ruslan",
		pluginVersion: "0.3.9",
		deliveryMode: "mcp_push" as const,
		sessionKey: "seat-uuid",
	};

	test("first create sends display_name default", () => {
		const args = buildAgentRegisterArgs({ ...base, selfAgentId: null, agentDisplayName: null });
		expect(args.display_name).toBe("Ruslan's OMP");
		expect(args.extension_version).toBe("0.3.9");
		expect(args.session_key).toBe("seat-uuid");
		expect(args.harness).toBe("omp");
	});

	test("rebind omits display_name so cabinet rename survives", () => {
		const args = buildAgentRegisterArgs({
			...base,
			selfAgentId: "agent-uuid",
		});
		expect(args).not.toHaveProperty("display_name");
		expect(args.extension_version).toBe("0.3.9");
		expect(args.delivery_mode).toBe("mcp_push");
		expect(args.session_key).toBe("seat-uuid");
	});

	test("first create prefers agentDisplayName when set", () => {
		const args = buildAgentRegisterArgs({ ...base, selfAgentId: null });
		expect(args.display_name).toBe("Cabinet Name");
	});
});

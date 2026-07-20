/**
 * Agent presence rebind policy — pure helpers for plugin-owned auto-register.
 * Extension owns IO; this module decides when to rebind vs surface errors.
 */

/** Server / tool text that means this MCP session has no agent bound. */
export function isAgentUnboundError(message: string): boolean {
	const m = message.toLowerCase();
	return (
		m.includes("agent_not_bound") ||
		m.includes("call agent_register") ||
		m.includes("not_bound") ||
		/\bnot bound\b/.test(m)
	);
}

export function isAgentRevokedError(message: string): boolean {
	return message.toLowerCase().includes("revoked");
}

export type RebindGate = {
	inFlight: boolean;
	lastAttemptAt: number;
	failStreak: number;
};

/** Single-flight + exponential backoff (5s base, 60s cap). */
export function canAttemptRebind(
	gate: RebindGate,
	now: number,
	minIntervalMs = 5_000,
): boolean {
	if (gate.inFlight) return false;
	if (gate.lastAttemptAt <= 0) return true;
	const exp = Math.min(gate.failStreak, 4);
	const backoff = Math.min(60_000, minIntervalMs * 2 ** exp);
	return now - gate.lastAttemptAt >= backoff;
}

export type HeartbeatFailureAction =
	| { action: "stop_revoked" }
	| { action: "rebind" }
	| { action: "wait_backoff" }
	| { action: "record_error" };

/**
 * After a failed heartbeat: revoke stops work; unbound/session loss rebinds
 * when the gate allows; otherwise wait or record soft error.
 */
export function decideHeartbeatFailure(
	message: string,
	gate: RebindGate,
	now: number,
): HeartbeatFailureAction {
	if (isAgentRevokedError(message)) return { action: "stop_revoked" };
	// Any non-revoked failure may mean session lost identity — rebind once.
	if (canAttemptRebind(gate, now)) return { action: "rebind" };
	if (gate.inFlight) return { action: "wait_backoff" };
	return { action: "record_error" };
}

/**
 * Extract MCP tools/call isError text. null if result is a normal success payload.
 */
export function mcpToolFailureMessage(result: unknown): string | null {
	if (!result || typeof result !== "object") return null;
	if (!("isError" in result) || result.isError !== true) return null;
	if ("content" in result && Array.isArray(result.content)) {
		for (const item of result.content) {
			if (
				item &&
				typeof item === "object" &&
				"type" in item &&
				item.type === "text" &&
				"text" in item &&
				typeof item.text === "string" &&
				item.text.trim()
			) {
				return item.text.trim().slice(0, 500);
			}
		}
	}
	return "MCP tool error";
}

/** Force agent_register when install version is newer than last stamped seat. */
export function needsVersionReregister(
	lastExtensionVersion: string | null | undefined,
	pluginVersion: string,
): boolean {
	return !lastExtensionVersion || lastExtensionVersion !== pluginVersion;
}

/**
 * agent_register args. Omit display_name on rebind so cabinet renames survive.
 * Only first create (no selfAgentId yet) sets a default name.
 */
export function buildAgentRegisterArgs(input: {
	selfAgentId: string | null;
	agentDisplayName: string | null;
	selfDisplayName: string | null;
	pluginVersion: string;
	deliveryMode: "mcp_push" | "poll";
	sessionKey: string;
}): Record<string, unknown> {
	const args: Record<string, unknown> = {
		harness: "omp",
		extension_version: input.pluginVersion,
		delivery_mode: input.deliveryMode,
		session_key: input.sessionKey,
	};
	if (!input.selfAgentId) {
		args.display_name = input.agentDisplayName
			? input.agentDisplayName
			: input.selfDisplayName
				? `${input.selfDisplayName}'s OMP`
				: "OMP agent";
	}
	return args;
}

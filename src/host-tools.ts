/**
 * Host MCP tools that stamp agent identity.
 * When the plugin holds the seat but cannot co-bind the host MCPManager
 * (bundled OMP dual-package: plugin import ≠ process singleton), these
 * tools are mute-online traps — hide them from the model surface.
 */

const HOST_MUTE_TRAP_TOOLS = new Set([
	"mcp__huddora_message_send",
	"mcp__huddora_agent_register",
	"mcp__huddora_agent_heartbeat",
	// Task mutations require the bound agent seat; host can't co-bind it, so these
	// return agent_not_bound from the host Streamable session. Excluded: task_list
	// is read-only and the plugin surface pins mine=true, so it stays available.
	"mcp__huddora_task_accept",
	"mcp__huddora_task_handoff",
	"mcp__huddora_task_complete",
	"mcp__huddora_task_fail",
]);

/** Host tool names that fail with agent_not_bound while only the bridge is seated. */
export function isHostHuddoraMuteTrapTool(name: string): boolean {
	return HOST_MUTE_TRAP_TOOLS.has(name);
}

/**
 * Filter active tool list for model surface.
 * - hostSeatBound: leave tools as-is (host co-own works).
 * - else + plugin seat held: strip mute-trap host tools.
 * - else: leave as-is (plugin offline; host may be sole path elsewhere).
 */
export function filterActiveToolsForSeat(input: {
	active: string[];
	hostSeatBound: boolean;
	pluginSeatHeld: boolean;
}): string[] {
	if (input.hostSeatBound || !input.pluginSeatHeld) return input.active.slice();
	return input.active.filter((n) => !isHostHuddoraMuteTrapTool(n));
}

/** Re-enable host mute-trap tools from catalog when host co-bind succeeds. */
export function mergeHostToolsWhenBound(input: {
	active: string[];
	all: string[];
	hostSeatBound: boolean;
}): string[] {
	if (!input.hostSeatBound) return input.active.slice();
	const host = input.all.filter(isHostHuddoraMuteTrapTool);
	return [...new Set([...input.active, ...host])];
}

/**
 * Human-readable doctor line for host bind state.
 * Returned copy is jargon-free and actionable; internal detail
 * (session_key, MCPManager, xd://, tool names) is never leaked.
 * The helper remains exported for compatibility even if doctor stops calling it.
 */
export function formatHostSeatDoctorLine(input: {
	hostSeatBound: boolean;
	lastBindDetail: string | null;
}): string {
	if (input.hostSeatBound) {
		return "Host seat: bound — can post from this OMP window.";
	}
	return "Host seat: away — posting uses the plugin connection. Run /huddora connect to bind here.";
}

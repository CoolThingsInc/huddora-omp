/**
 * Pure human-facing status and doctor presentation helpers.
 *
 * Replaces operator/raw dumps with a clean lobby card the user can read.
 * No bridge, courier, lease, seat-stamp, host MCPManager, mute-trap, xd://,
 * session_key, or other infrastructure jargon leaks into the human surface.
 *
 * Extension owns IO and the timing of refresh; this module only shapes strings.
 */

/** Presence as the user understands it. */
export type HumanPresence = "online" | "offline" | "needs_setup" | "revoked";

/** Configuration validity as the doctor surface understands it. */
export type ConfigStatus = (typeof CONFIG_STATUS_VALUES)[number];
/** Runtime literal list backing {@link ConfigStatus} — single source of truth. */
export const CONFIG_STATUS_VALUES = ["valid", "missing", "invalid"] as const;

/** Delivery-light hint colors (same vocabulary as delivery-health). */
export type DeliveryLight = "green" | "amber" | "red";

/** Input shared by status and doctor; nullable fields use null (not omission)
 *  so partial snapshots from extension flow in without sentinel defaults. */
export type HumanStatusInput = {
	pluginVersion: string;
	/** Agent display label (human name), or null when unregistered. */
	agentLabel: string | null;
	/** Agent UUID, or null when unregistered. */
	agentId: string | null;
	/** Room display label, or null when unbound. */
	roomLabel: string | null;
	/** Full room UUID, or null when unbound. Shown on its own line when present. */
	roomId: string | null;
	presence: HumanPresence;
	paused: boolean;
	/** MCP/transport connection: "connected" | "disconnected" | "unavailable" | other. */
	connection: string;
	configStatus: ConfigStatus;
	lastError: string | null;
	deliveryLight: DeliveryLight;
};

/** A single diagnosed problem for the human doctor surface. */
export type HumanProblem = {
	title: string;
	cause: string;
	fix: string;
	level: "info" | "warning" | "error";
};

const SITE = "huddora.coolthings.fyi";

/**
 * Clean lobby card: brand/version/state, Agent, Room (+ full room_id copy line),
 * and exactly one Next line. No operator jargon, no model instructions.
 */
export function formatHumanStatus(input: HumanStatusInput): string {
	const state = stateLabel(input);
	const agent = agentLine(input);
	const room = roomLine(input);
	const lines: string[] = [
		`Huddora v${input.pluginVersion} — ${state}`,
		`Agent: ${agent}`,
		`Room: ${room}`,
	];
	if (input.roomId) lines.push(input.roomId);
	lines.push(`Next: ${nextLine(input)}`);
	return lines.join("\n");
}

/**
 * Diagnose the most specific human problem from the current snapshot.
 * Returns null when everything looks healthy (bound + online + no error +
 * valid config). Prefer the narrowest issue so the fix is actionable.
 */
export function diagnoseHumanProblem(input: HumanStatusInput): HumanProblem | null {
	if (input.presence === "revoked") {
		return {
			title: "Agent access revoked",
			cause: "Agent access was revoked in Huddora. The agent identity can be revoked separately from your OAuth sign-in.",
			fix: `Open ${SITE} agents/account, re-authorize or recreate the agent, then run /huddora connect.`,
			level: "error",
		};
	}

	if (input.configStatus === "invalid") {
		return {
			title: "Invalid Huddora config",
			cause: "The .huddora/config.json file exists but could not be parsed or failed validation.",
			fix: "Fix the JSON in .huddora/config.json (check room_id format and fields) or remove it to start fresh.",
			level: "error",
		};
	}

	const err = (input.lastError ?? "").toLowerCase();

	if (/oauth|token|401|unauthoriz|reauth|credential|expired|forbidden/.test(err)) {
		return {
			title: "OAuth token missing or expired",
			cause: "The Huddora MCP connection lost its OAuth token (expired or revoked by the provider).",
			fix: "Run /mcp reauth huddora to refresh the OAuth token, then /huddora connect.",
			level: "warning",
		};
	}

	if (/preempt|seat taken|bound_elsewhere|another session|another window/.test(err)) {
		return {
			title: "Another window connected",
			cause: "Another OMP window is connected to this agent; only one live window is allowed at a time.",
			fix: "Close the other window or run /huddora connect to move the connection here.",
			level: "warning",
		};
	}

	if (input.connection === "disconnected" || input.presence === "offline") {
		return {
			title: "Huddora connection unavailable",
			cause: "The Huddora connection is not currently available.",
			fix: "Run /huddora connect; if OAuth expired, run /mcp reauth huddora first.",
			level: "warning",
		};
	}

	if (input.connection === "unavailable") {
		return {
			title: "Huddora unavailable",
			cause: "No MCP manager or host API was found in this OMP process; the plugin cannot reach Huddora.",
			fix: "Restart OMP so the plugin's MCP server registers, then run /huddora connect.",
			level: "error",
		};
	}

	if (!input.roomId) {
		return {
			title: "No room bound",
			cause: "This Huddora session is not bound to any room yet.",
			fix: `Create or join a room at ${SITE}, then run /huddora room <room_id>.`,
			level: "warning",
		};
	}

	// Bound, connected, no error → healthy.
	return null;
}

/**
 * Exactly three lines for the human doctor: title, cause, fix.
 * Pass null for a healthy single-line report.
 */
export function formatHumanDoctor(problem: HumanProblem | null): string {
	if (!problem) return "Huddora looks healthy.";
	return `${problem.title}\n${problem.cause}\n${problem.fix}`;
}

/** Human-facing state word from presence + paused. */
function stateLabel(input: HumanStatusInput): string {
	const err = (input.lastError ?? "").toLowerCase();
	const reconnect =
		/preempt|rebind|unbound|seat taken|agent_not_bound|not bound|another window|another session/.test(err);
	if (input.presence === "revoked") return "Revoked";
	if (input.presence === "needs_setup")
		return reconnect ? "Needs reconnect" : "Needs setup";
	if (input.paused) return "Away";
	if (reconnect) return "Needs reconnect";
	if (input.presence === "online") return "Ready";
	return "Away";
}

function agentLine(input: HumanStatusInput): string {
	if (!input.agentId) return "not registered";
	return input.agentLabel?.trim() || "registered";
}

function roomLine(input: HumanStatusInput): string {
	if (!input.roomId) return "none";
	return input.roomLabel?.trim() || input.roomId;
}

/** Exactly one Next line scoped to the most pressing human task. */
function nextLine(input: HumanStatusInput): string {
	const problem = diagnoseHumanProblem(input);
	if (problem) return `${problem.title}. ${problem.fix}`;
	return "ready";
}

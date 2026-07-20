/**
 * Always-visible Huddora status (OMP footer via ctx.ui.setStatus).
 * Pure formatters — extension owns IO and when to refresh.
 */

export const STATUS_KEY = "huddora";

export type Presence = "online" | "offline" | "needs_setup" | "revoked";

export type StatusSurfaceInput = {
	pluginVersion: string;
	agentDisplayName: string | null;
	selfAgentId: string | null;
	roomId: string | null;
	roomName: string | null;
	presence: Presence;
	/** bridge | poll | unavailable | unknown */
	delivery: string;
	paused: boolean;
	bridgeActive: boolean;
	connection: string;
	lastError: string | null;
};

/** Honest presence from seat + last heartbeat/bridge signals. */
export function derivePresence(input: {
	selfAgentId: string | null;
	lastError: string | null;
	heartbeatOk: boolean;
	bridgeReady: boolean;
}): Presence {
	const err = (input.lastError ?? "").toLowerCase();
	if (err.includes("revoked")) return "revoked";
	if (!input.selfAgentId) return "needs_setup";
	if (!input.bridgeReady || !input.heartbeatOk) return "offline";
	return "online";
}

function shortRoomId(roomId: string): string {
	return roomId.length > 12 ? `${roomId.slice(0, 8)}…` : roomId;
}

function roomLabel(roomId: string | null, roomName: string | null): string {
	if (!roomId) return "no room";
	const name = roomName?.trim();
	if (name) return name;
	return shortRoomId(roomId);
}

function agentLabel(agentDisplayName: string | null, selfAgentId: string | null): string {
	const name = agentDisplayName?.trim();
	if (name) return name;
	if (selfAgentId) return shortRoomId(selfAgentId);
	return "unbound";
}

/**
 * One-line footer/status bar text (plain; theme applied by caller when wanted).
 * Always glanceable: version · presence · agent · room.
 */
export function formatStatusLine(input: StatusSurfaceInput): string {
	const agent = agentLabel(input.agentDisplayName, input.selfAgentId);
	const room = roomLabel(input.roomId, input.roomName);
	const pause = input.paused ? " · paused" : "";
	return `Huddora v${input.pluginVersion} · ${input.presence} · ${agent} · ${room}${pause}`;
}

/**
 * Multi-line /huddora status body (plugin-owned, not LLM).
 */
export function formatStatusReport(input: StatusSurfaceInput): string {
	const agent = agentLabel(input.agentDisplayName, input.selfAgentId);
	const room = roomLabel(input.roomId, input.roomName);
	const roomIdLine = input.roomId
		? `room_id=${input.roomId} (${input.roomName?.trim() || room}) — room_snapshot this id; skip room_list when bound.`
		: null;
	const session = input.bridgeActive
		? "active (auto)"
		: "starting — needs OAuth token after /mcp reauth huddora";
	const next = input.lastError
		? `Next: ${input.lastError}`
		: input.roomId
			? "Ready."
			: "Next: /huddora room";
	return [
		`Huddora v${input.pluginVersion} · ${input.presence}${input.paused ? " · paused" : ""}`,
		`Agent: ${agent}${input.selfAgentId ? " (registered)" : " (not registered)"}`,
		`Room: ${room}`,
		roomIdLine,
		`Plugin: ${input.connection}; delivery: ${input.delivery}; session: ${session}.`,
		next,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

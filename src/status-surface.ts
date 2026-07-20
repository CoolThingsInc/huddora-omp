/**
 * Always-visible Huddora status (OMP footer via ctx.ui.setStatus).
 * Pure formatters — extension owns IO and when to refresh.
 *
 * setStatus only takes a string; color via theme.fg when available.
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

/** Minimal theme surface used for segmented footer coloring. */
export type StatusTheme = {
	fg: (color: string, text: string) => string;
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

// Nerd Font glyphs (Codicons/Material/Octicons set common in OMP terminals).
const I = {
	brand: "󰒍", // nf-md-broadcast
	agent: "", // nf-oct-person
	room: "󰭹", // nf-md-message-text
	pause: "⏸",
} as const;

const PRESENCE: Record<
	Presence,
	{ icon: string; label: string; color: "success" | "warning" | "error" | "dim" }
> = {
	online: { icon: "●", label: "online", color: "success" },
	offline: { icon: "○", label: "offline", color: "warning" },
	needs_setup: { icon: "⚠", label: "needs setup", color: "dim" },
	revoked: { icon: "󰅙", label: "revoked", color: "error" },
};

export function presenceThemeColor(presence: Presence): "success" | "warning" | "error" | "dim" {
	return PRESENCE[presence].color;
}

/**
 * One-line footer/status bar. Glanceable: brand · presence · agent · room.
 * Pass theme for segmented colors; plain string (icons only) without it.
 */
export function formatStatusLine(input: StatusSurfaceInput, theme?: StatusTheme): string {
	const p = PRESENCE[input.presence];
	const agent = agentLabel(input.agentDisplayName, input.selfAgentId);
	const room = roomLabel(input.roomId, input.roomName);
	const brand = `${I.brand} Huddora ${input.pluginVersion}`;
	const presence = `${p.icon} ${p.label}`;
	const agentPart = `${I.agent} ${agent}`;
	const roomPart = `${I.room} ${room}`;
	const pausePart = input.paused ? `${I.pause} paused` : "";

	if (!theme) {
		return [brand, presence, agentPart, roomPart, pausePart].filter(Boolean).join("  ");
	}

	const parts = [
		theme.fg("accent", brand),
		theme.fg(p.color, presence),
		theme.fg("muted", agentPart),
		theme.fg("muted", roomPart),
	];
	if (pausePart) parts.push(theme.fg("warning", pausePart));
	return parts.join("  ");
}

/**
 * Multi-line /huddora status body (plugin-owned, not LLM).
 */
export function formatStatusReport(input: StatusSurfaceInput): string {
	const p = PRESENCE[input.presence];
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
	const pause = input.paused ? `  ${I.pause} paused` : "";
	return [
		`${I.brand} Huddora ${input.pluginVersion}  ${p.icon} ${p.label}${pause}`,
		`${I.agent} Agent: ${agent}${input.selfAgentId ? " (registered)" : " (not registered)"}`,
		`${I.room} Room: ${room}`,
		roomIdLine,
		`Plugin: ${input.connection}; delivery: ${input.delivery}; session: ${session}.`,
		next,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

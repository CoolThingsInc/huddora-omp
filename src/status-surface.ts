/**
 * Backward-compatible facade over the new pure modules (hud + presentation).
 *
 * The legacy public exports stay alive so extension.ts and existing callers keep
 * compiling: `Presence`, `StatusSurfaceInput`, `StatusTheme`, `derivePresence`,
 * `formatStatusLine`, `formatStatusReport`, `presenceThemeColor`, `STATUS_KEY`.
 *
 * Rendering is now delegated:
 *   - `formatStatusLine`      → hud.deriveHudModel + hud.formatHudStatusFallback
 *     (one-line, ANSI-free — OMP strips ANSI in setStatus, so the theme
 *     parameter is accepted for signature compatibility but intentionally
 *     unused here).
 *   - `formatStatusWidgetLines` → hud.deriveHudModel + hud.formatHudWidgetLines
 *     (2–3 lines for ctx.ui.setWidget, themed when a theme is passed).
 *   - `formatStatusReport`    → presentation.formatHumanStatus via
 *     `toHumanStatusInput` (clean lobby card, no operator jargon).
 *
 * `derivePresence` and `presenceThemeColor` keep their original behavior — the
 * presence matrix is the single source of truth for here/away/needs_setup/revoked.
 */

import {
	deriveHudModel,
	formatHudStatusFallback,
	formatHudWidgetLines,
	type HudInput,
	type HudTheme,
} from "./hud";
import {
	formatHumanStatus,
	type HumanStatusInput,
	type ConfigStatus,
	type DeliveryLight,
} from "./presentation";

export const STATUS_KEY = "huddora";

export type Presence = "online" | "offline" | "needs_setup" | "revoked";

export type StatusSurfaceInput = {
	pluginVersion: string;
	/** Last PLUGIN_VERSION this process successfully registered (may lag until rebind). */
	lastExtensionVersion?: string | null;
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
	/** True when this process exclusively holds the agent seat and is online. */
	seatExclusive?: boolean;
	/** Courier delivery health hint: green/amber/red from lease freshness + bridge. */
	deliveryLight?: "green" | "amber" | "red";
	/** Epoch ms when the durable room_watch lease expires; null when unknown/unheld. */
	leaseExpiresAt?: number | null;
	/** True (default) when a courier owns durable wake: lease + SSE wake + poll fallback. */
	courierPrimary?: boolean;
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
	if (input.bridgeReady && input.heartbeatOk) return "online";
	// Seat exists but this surface cannot send (rebind/preempt/unbound) → needs reconnect.
	if (/rebind|preempt|agent_not_bound|seat taken|not bound|unbound|another window/.test(err)) {
		return "needs_setup";
	}
	return "offline";
}

const PRESENCE: Record<
	Presence,
	{ color: "success" | "warning" | "error" | "dim" }
> = {
	online: { color: "success" },
	offline: { color: "warning" },
	needs_setup: { color: "dim" },
	revoked: { color: "error" },
};

export function presenceThemeColor(presence: Presence): "success" | "warning" | "error" | "dim" {
	return PRESENCE[presence].color;
}

/**
 * Map this surface's nullable lastError/connection vocabulary onto the
 * presentation layer's `connection` enum. Diagnose keys on `disconnected` and
 * `unavailable`; everything else falls through to presence-derived branches.
 */
function mapConnection(input: StatusSurfaceInput): string {
	switch (input.connection) {
		case "bridge":
		case "poll":
			return "connected";
		case "unavailable":
			return "unavailable";
		default:
			// unknown / other — derive from presence so offline routes to the
			// "Disconnected" branch rather than a healthy default.
			return input.presence === "offline" ? "disconnected" : "connected";
	}
}

/**
 * Convert a legacy `StatusSurfaceInput` into a presentation `HumanStatusInput`.
 *
 * Config status is not modeled in the legacy input, so per the facade contract:
 * `valid` when a room is bound, `missing` when no room (this routes the no-room
 * case to the "No room bound" diagnosis rather than the "invalid config" one).
 */
export function toHumanStatusInput(input: StatusSurfaceInput): HumanStatusInput {
	const configStatus: ConfigStatus = input.roomId ? "valid" : "missing";
	const deliveryLight: DeliveryLight = input.deliveryLight ?? "green";
	return {
		pluginVersion: input.pluginVersion,
		agentLabel: input.agentDisplayName,
		agentId: input.selfAgentId,
		roomLabel: input.roomName,
		roomId: input.roomId,
		presence: input.presence,
		paused: input.paused,
		connection: mapConnection(input),
		configStatus,
		lastError: input.lastError,
		deliveryLight,
	};
}

/** Build a `HudInput` from `StatusSurfaceInput` (drop legacy-only fields). */
function toHudInput(input: StatusSurfaceInput): HudInput {
	return {
		pluginVersion: input.pluginVersion,
		agentDisplayName: input.agentDisplayName,
		selfAgentId: input.selfAgentId,
		roomId: input.roomId,
		roomName: input.roomName,
		presence: input.presence,
		paused: input.paused,
		deliveryLight: input.deliveryLight ?? null,
		leaseExpiresAt: input.leaseExpiresAt ?? null,
		lastError: input.lastError,
	};
}

/**
 * One-line footer/status bar for `ctx.ui.setStatus`. ANSI-free and compact:
 * the new `HUD_*` glyph + state label + room · agent (+ "paused" when paused).
 *
 * `theme` is accepted to preserve the existing signature but intentionally NOT
 * applied: OMP strips ANSI escapes from `setStatus` strings, so coloring here
 * would only produce noise on copy-paste. Themed rendering lives in
 * `formatStatusWidgetLines`, which targets `setWidget` (escape-preserved).
 */
export function formatStatusLine(input: StatusSurfaceInput, _theme?: StatusTheme): string {
	return formatHudStatusFallback(deriveHudModel(toHudInput(input)));
}

/**
 * HUD widget lines for `ctx.ui.setWidget(STATUS_KEY, lines, { placement })`.
 * Returns exactly 2 (ready) or 3 (non-ready: setup/reconnect/away/revoked)
 * short lines. Pass a `theme` to color the brand/state + context lines; omit
 * it for plain monochrome lines. Never carries courier/lease/session jargon.
 */
export function formatStatusWidgetLines(input: StatusSurfaceInput, theme?: HudTheme): string[] {
	return formatHudWidgetLines(deriveHudModel(toHudInput(input)), theme);
}

/**
 * Multi-line `/huddora status` body — a clean lobby card delegated to
 * `presentation.formatHumanStatus`. Brand/version/state, Agent, Room (+ full
 * room_id on its own copy line when bound), and exactly one Next line scoped to
 * the most pressing human task. No operator jargon, no model instructions, no
 * courier/seat-stamp/xd/session_key noise.
 */
export function formatStatusReport(input: StatusSurfaceInput): string {
	return formatHumanStatus(toHumanStatusInput(input));
}

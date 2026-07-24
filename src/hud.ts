/**
 * Pure HUD view model + render helpers for OMP `ctx.ui.setWidget`.
 *
 * The extension owns IO (when to call setWidget/setStatus); this module owns
 * deriving a small, glanceable state and formatting it for the two surfaces:
 *   - `formatHudWidgetLines` → the multi-line widget (2–3 short lines, themed)
 *   - `formatHudStatusFallback` → the one-line `setStatus` text (no ANSI)
 *
 * No networking, no timers, no storage. Deterministic given (input, now).
 *
 * Vocabulary note: this surface deliberately stays jargon-free. The earlier
 * status layer (status-surface.ts) carries courier-primary / lease / seat-stamp
 * internals for its multi-line report; the HUD widget is the one-line glanceable
 * the human reads mid-turn, so it speaks in `ready / away / reconnect / …`
 * rather than transport terminology.
 */

import type { Presence } from "./status-surface";
import {
	HUDDORA_GLYPH,
	HUDDORA_WORD,
	HUD_COLOR,
	HUD_NEXT_ACTION,
	HUD_STATE_LABELS,
	type HudStateKind,
} from "./brand";

/** Re-export Presence so consumers can import the union from one place. */
export type { Presence } from "./status-surface";

/**
 * Minimal theme surface: `fg(color, text)` returns styled text. Mirrors the
 * subset of `ctx.ui.theme.fg` the widget actually uses, so integration passes
 * `ctx.ui.theme` (or a plain identity `(_c, t) => t` in non-interactive modes).
 */
export type HudTheme = {
	fg: (color: string, text: string) => string;
};

/** Courier delivery light hint (green/amber/red), optional in the input. */
export type HudDeliveryLight = "green" | "amber" | "red";

/**
 * Normalized HUD state. `state` drives theme + next-action; `paused` is kept
 * alongside so the formatter can prefix a pause marker without re-deriving.
 */
export type HudState = HudStateKind;

/**
 * The normalized view model `formatHudWidgetLines` renders. Every field is
 * plain (strings/numbers) so it serializes cleanly and is trivial to assert.
 */
export type HudModel = {
	/** One of ready/setup/reconnect/away/revoked — drives color + next action. */
	state: HudState;
	/** Short human label, e.g. "ready", "reconnect". */
	label: string;
	/** OMP Theme color name for this state (success / warning / … ). */
	color: string;
	/** Human agent label: display name if known, else "unregistered agent". */
	agent: string;
	/** Human room label: room name if known, else short id, else "no room". */
	room: string;
	/** Whole seconds remaining until the watch lease expires; 0 when unset/expired. */
	leaseSeconds: number;
	/** True when delivery is paused (user opted out; surfaces in the away state). */
	paused: boolean;
	/** Raw presence carried through for callers that want the underlying signal. */
	presence: Presence;
	/** One short next-action sentence; empty when ready. */
	nextAction: string;
	/** Plugin version string (echoed for the brand line). */
	pluginVersion: string;
};

/**
 * Input the extension assembles from durable state + live transport signals.
 * `pluginVersion` is the only required string identity; everything else degrades
 * gracefully when unknown (nulls → setup / "no room" / "unregistered agent").
 */
export type HudInput = {
	pluginVersion: string;
	agentDisplayName: string | null;
	selfAgentId: string | null;
	roomId: string | null;
	roomName: string | null;
	/** Reused compatible union: online|offline|needs_setup|revoked. */
	presence: Presence;
	/** True when background delivery is paused. */
	paused: boolean;
	/** Optional courier delivery light; surfaced as a single hint glyph when set. */
	deliveryLight?: HudDeliveryLight | null;
	/** Epoch ms when the durable room_watch lease expires; null when unheld. */
	leaseExpiresAt?: number | null;
	/** Last transport/seat error string; drives revoke + reconnect detection. */
	lastError: string | null;
};

const RECONNECT_ERR = /preempt|rebind|seat taken|agent_not_bound|not bound|unbound|preempted/i;
const REVOKE_ERR = /revoked/i;

function shortRoomId(roomId: string): string {
	return roomId.length > 12 ? `${roomId.slice(0, 8)}…` : roomId;
}

function roomLabel(roomId: string | null, roomName: string | null): string {
	if (!roomId) return "no room";
	const name = roomName?.trim();
	return name ? name : shortRoomId(roomId);
}

function agentLabel(agentDisplayName: string | null, selfAgentId: string | null): string {
	const name = agentDisplayName?.trim();
	if (name) return name;
	return selfAgentId ? "registered agent" : "unregistered agent";
}

function leaseSecondsOf(expiresAt: number | null | undefined, now: number): number {
	if (typeof expiresAt !== "number") return 0;
	const ms = expiresAt - now;
	if (ms <= 0 || !Number.isFinite(ms)) return 0;
	return Math.round(ms / 1000);
}

/**
 * Derive the normalized HUD model from raw inputs. Pure: equal inputs ⇒ equal
 * model. `now` defaults to `Date.now()` so callers with a clock inject a fixed
 * instant in tests (otherwise we never invoke the wall clock implicitly).
 */
export function deriveHudModel(input: HudInput, now: number = Date.now()): HudModel {
	const err = input.lastError ?? "";

	// Precedence is intentional and fixed: revoked > no-room setup > paused
	// (away) > reconnect > offline (away) > online (ready). Tests below pin each.
	let state: HudState;
	const isRevoked = input.presence === "revoked" || REVOKE_ERR.test(err);
	const noRoom = !input.roomId;
	const reconnectSignal =
		input.presence === "needs_setup" || RECONNECT_ERR.test(err);

	if (isRevoked) {
		state = "revoked";
	} else if (noRoom) {
		state = "setup";
	} else if (input.paused) {
		state = "away";
	} else if (reconnectSignal) {
		state = "reconnect";
	} else if (input.presence === "offline") {
		state = "away";
	} else {
		state = "ready";
	}

	const nextAction = state === "ready" ? "" : HUD_NEXT_ACTION[state];

	return {
		state,
		label: HUD_STATE_LABELS[state],
		color: HUD_COLOR[state],
		agent: agentLabel(input.agentDisplayName, input.selfAgentId),
		room: roomLabel(input.roomId, input.roomName),
		leaseSeconds: leaseSecondsOf(input.leaseExpiresAt, now),
		paused: Boolean(input.paused),
		presence: input.presence,
		nextAction,
		pluginVersion: input.pluginVersion,
	};
}

/**
 * Render the HUD widget as exactly 2 or 3 short lines:
 *   1. branded state  — `◆ Huddora v0.3.27 — Needs reconnect`
 *   2. room/agent     — `Slupport · Alice
 *   3. next action    — only when state !== "ready" (setup/reconnect/away/revoked)
 *
 * Returns a `string[]` ready for `ctx.ui.setWidget(key, lines)`. With a `theme`,
 * the brand/state line is colored by the model's semantic color and the context
 * line is muted for visual hierarchy; without a theme the lines are plain.
 * Never exceeds 3 lines, never includes courier/lease/session jargon.
 */
export function formatHudWidgetLines(model: HudModel, theme?: HudTheme): string[] {
	const brand = `${HUDDORA_GLYPH} ${HUDDORA_WORD} v${model.pluginVersion} — ${model.label}`;
	const context = `${model.room} · ${model.agent}`;
	const showNext = model.state !== "ready";

	if (!theme) {
		const lines = [brand, context];
		if (showNext) lines.push(model.nextAction);
		return lines;
	}

	const lines = [theme.fg(model.color, brand), theme.fg("muted", context)];
	if (showNext) lines.push(theme.fg(model.color, model.nextAction));
	return lines;
}

/**
 * One-line, ANSI-free compact status for `ctx.ui.setStatus`. Concatenates the
 * branded state with room/agent, dropping the next-action so the footer stays
 * a single glanceable line regardless of state. Always plain text: this surface
 * is monochrome and must never carry escape codes.
 */
export function formatHudStatusFallback(model: HudModel): string {
	const head = `${HUDDORA_GLYPH} ${HUDDORA_WORD} v${model.pluginVersion} — ${model.label}`;
	const parts = [head, `${model.room} · ${model.agent}`];
	if (model.paused) parts.push("paused");
	return parts.join("  ");
}

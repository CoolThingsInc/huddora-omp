/**
 * Huddora brand identity for the HUD surface.
 *
 * Glyph + semantic text labels ONLY. No hex values: OMP Theme resolves a
 * fixed set of named colors (accent / success / warning / error / muted / dim),
 * so brand stays font/Theme-agnostic and never invents colors the theme
 * cannot name.
 */

/**
 * Monochrome diamond — renders in any font/Theme without a Nerd Font installed,
 * keeps the HUD line one cell wide, and reads as a "marker" rather than an
 * emoji badge (so it does not skew status-bar height on copy-paste terminals).
 */
export const HUDDORA_GLYPH = "◆";

/** Wordmark used where a longer brand string is appropriate. */
export const HUDDORA_WORD = "Huddora";

/**
 * Short, human-glanceable state labels. These are the words that ship to the
 * footer/widget; keep them stable so users train muscle memory on meaning.
 *
 * Kept here (not in hud.ts) so brand voice is owned in one place and the view
 * model only normalizes *which* label applies, never rewords it.
 */
export const HUD_STATE_LABELS: Readonly<Record<HudStateKind, string>> = {
	ready: "Ready",
	setup: "Needs setup",
	reconnect: "Needs reconnect",
	away: "Away",
	revoked: "Revoked",
};

export type HudStateKind = "ready" | "setup" | "reconnect" | "away" | "revoked";

/**
 * OMP Theme color names used by the HUD. Values are theme-resolved names, not
 * hex — `HudTheme.fg` is handed these as-is so the active Theme owns the hue.
 * `dim` doubles as "informational / no problem" so the footer is not noisy.
 */
export const HUD_COLOR: Readonly<Record<HudStateKind, string>> = {
	ready: "success",
	setup: "dim",
	reconnect: "warning",
	away: "muted",
	revoked: "error",
};

/** Compact next-action hints, one per non-ready state. Stable wording. */
export const HUD_NEXT_ACTION: Readonly<Record<Exclude<HudStateKind, "ready">, string>> = {
	setup: "create or join a room, then /huddora room",
	reconnect: "run /huddora connect",
	away: "resume with /huddora resume",
	revoked: "open huddora.coolthings.fyi agents/account, re-authorize or recreate, then /huddora connect",
};

/**
 * Branded custom-message renderers for the OMP interactive TUI.
 *
 * These factories are pure view transforms: given a CustomMessage (content + a
 * boolean `expanded` flag) and the active OMP Theme, each returns a small
 * Container of Text rows. They perform no network I/O and mutate no state —
 * the underlying message content stays intact, so the same message renders as
 * flat text in headless/RPC mode (where no renderer is registered).
 *
 * `CUSTOM_MSG_TYPE` (the unique room-event custom type, shared with types.ts) is
 * the display metadata OMP uses to pick a renderer. The `<huddora_event>` wire
 * envelope inside `content` is orthogonal model text, not the customType.
 */

import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { CUSTOM_MSG_TYPE } from "./types";
import { HUDDORA_GLYPH, HUDDORA_WORD } from "./brand";

/** Custom type for a single Huddora room event (e.g. an injected chat message). */
export const HUDDORA_EVENT_TYPE = CUSTOM_MSG_TYPE;
/** Custom type for session guidance / posture notes injected from a room. */
export const HUDDORA_GUIDANCE_TYPE = "huddora-guidance";
/** Custom type for a Huddora status "lobby card" (bound room, agent, next step). */
export const HUDDORA_STATUS_TYPE = "huddora-status";

/** Subset of the OMP Theme used by these renderers. */
export interface RendererTheme {
	/** Style `text` with a named theme foreground color (accent/dim/muted/…). */
	fg(color: string, text: string): string;
	/** Bold a string. */
	bold(text: string): string;
}

/** Subset of the OMP pi extension API needed to register renderers. */
export interface PiRegistrar {
	registerMessageRenderer(customType: string, renderer: any): void;
}

/** Render(er) signature — parallel to OMP's MessageRenderer<CustomMessage>. */
export type RendererFn = (
	message: { content: any },
	options: { expanded: boolean },
	theme: any,
) => Component;

/**
 * Pull the raw text out of a CustomMessage's content. Content is either a flat
 * string (our own injected events) or a structured TextContent array; we only
 * carry strings here, so the array branch is a defensive fallback.
 */
function messageText(message: { content: string }): string {
	return message.content ?? "";
}

/** First non-empty line of a block, truncated for a collapsed preview. */
function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return trimmed;
	}
	return "";
}

/** Branded, accent-colored title line. */
function brandedTitle(theme: RendererTheme, label: string): string {
	return theme.fg("accent", `${HUDDORA_GLYPH} ${HUDDORA_WORD} ${label}`);
}

/** Container holding the given text rows; one Text per logical block. */
function withRows(...rows: string[]): Container {
	const container = new Container();
	for (const row of rows) container.addChild(new Text(row));
	return container;
}

/**
 * Event renderer: branded title + visible body. Collapsed shows a compact
 * first-line preview; expanded shows the full content.
 */
export function renderHuddoraEvent(
	message: { content: string },
	options: { expanded: boolean },
	theme: RendererTheme,
): Container {
	const body = messageText(message);
	const title = brandedTitle(theme, "event");
	if (options.expanded) return withRows(title, body);
	const preview = firstLine(body);
	return withRows(title, preview);
}

/**
 * Guidance renderer: dim branded title + body. Collapsed shows a compact
 * preview; expanded shows the full content.
 */
export function renderHuddoraGuidance(
	message: { content: string },
	options: { expanded: boolean },
	theme: RendererTheme,
): Container {
	const body = messageText(message);
	const title = theme.fg("dim", `${HUDDORA_GLYPH} ${HUDDORA_WORD} guidance`);
	if (options.expanded) return withRows(title, body);
	const preview = firstLine(body);
	return withRows(title, preview);
}

/**
 * Status renderer: accent-branded title + lobby-card content as provided.
 * Does not collapse the card body — a status card is short by construction.
 */
export function renderHuddoraStatus(
	message: { content: string },
	_options: { expanded: boolean },
	theme: RendererTheme,
): Container {
	const body = messageText(message);
	const title = theme.bold(brandedTitle(theme, "status"));
	return withRows(title, body);
}

/**
 * Register all three Huddora custom-message renderers with the OMP extension
 * API. Called once at activation; idempotent only if the host dedupes on
 * customType (it does — `registerMessageRenderer` replaces per type).
 */
export function registerHuddoraRenderers(pi: PiRegistrar): void {
	pi.registerMessageRenderer(HUDDORA_EVENT_TYPE, renderHuddoraEvent);
	pi.registerMessageRenderer(HUDDORA_GUIDANCE_TYPE, renderHuddoraGuidance);
	pi.registerMessageRenderer(HUDDORA_STATUS_TYPE, renderHuddoraStatus);
}

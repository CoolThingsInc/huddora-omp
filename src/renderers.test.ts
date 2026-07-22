import { describe, expect, test } from "bun:test";
import type { Container } from "@oh-my-pi/pi-tui";
import { HUDDORA_GLYPH, HUDDORA_WORD } from "./brand";
import {
	HUDDORA_EVENT_TYPE,
	HUDDORA_GUIDANCE_TYPE,
	HUDDORA_STATUS_TYPE,
	type RendererFn,
	type RendererTheme,
	registerHuddoraRenderers,
	renderHuddoraEvent,
	renderHuddoraGuidance,
	renderHuddoraStatus,
} from "./renderers";

/** Plain theme that passes text through, recording color names for assertions. */
function recordedTheme(): RendererTheme & { seen: string[] } {
	const seen: string[] = [];
	return {
		seen,
		fg: (color, text) => {
			seen.push(color);
			return text;
		},
		bold: text => text,
	};
}

const fakeTheme: RendererTheme = {
	fg: (_color, text) => text,
	bold: text => text,
};

/** Rows a renderer's Container emits at a width — Container.render is public. */
function rows(cmp: Container, width = 80): string[] {
	return [...cmp.render(width)];
}

describe("Huddora message renderers", () => {
	test("registerHuddoraRenderers registers all three custom types", () => {
		const registered = new Map<string, RendererFn>();
		const pi = {
			registerMessageRenderer: (type: string, fn: RendererFn) => registered.set(type, fn),
		};

		registerHuddoraRenderers(pi);

		expect(registered.size).toBe(3);
		expect(registered.has(HUDDORA_EVENT_TYPE)).toBe(true);
		expect(registered.has(HUDDORA_GUIDANCE_TYPE)).toBe(true);
		expect(registered.has(HUDDORA_STATUS_TYPE)).toBe(true);
	});

	test("each renderer returns a Container with a render(width) method", () => {
		const message = { content: "hello world" };

		const eventCmp = renderHuddoraEvent(message, { expanded: true }, fakeTheme);
		const guidanceCmp = renderHuddoraGuidance(message, { expanded: true }, fakeTheme);
		const statusCmp = renderHuddoraStatus(message, { expanded: true }, fakeTheme);

		expect(eventCmp).toBeTruthy();
		expect(guidanceCmp).toBeTruthy();
		expect(statusCmp).toBeTruthy();
		// @oh-my-pi/pi-tui Container exposes render(width) — assert it yields rows.
		expect(typeof eventCmp.render).toBe("function");
		expect(rows(eventCmp).length).toBeGreaterThan(0);
	});

	test("collapsed event is shorter than expanded", () => {
		const body = ["line one", "line two", "line three"].join("\n");
		const message = { content: body };

		const collapsed = rows(renderHuddoraEvent(message, { expanded: false }, fakeTheme));
		const expanded = rows(renderHuddoraEvent(message, { expanded: true }, fakeTheme));

		expect(collapsed.length).toBeLessThan(expanded.length);
	});

	test("collapsed event shows only first-line preview content", () => {
		const message = { content: "first content line\nsecond line\nthird line" };

		const rendered = rows(renderHuddoraEvent(message, { expanded: false }, fakeTheme)).join("\n");

		expect(rendered).toContain("first content line");
		expect(rendered).not.toContain("second line");
		expect(rendered).not.toContain("third line");
	});

	test("expanded event shows all content lines", () => {
		const message = { content: "first content line\nsecond line\nthird line" };

		const rendered = rows(renderHuddoraEvent(message, { expanded: true }, fakeTheme)).join("\n");

		expect(rendered).toContain("first content line");
		expect(rendered).toContain("second line");
		expect(rendered).toContain("third line");
	});

	test("content remains represented — both expanded and collapsed carry the body", () => {
		const message = { content: "the body text" };

		const collapsed = rows(renderHuddoraEvent(message, { expanded: false }, fakeTheme)).join("\n");
		const expanded = rows(renderHuddoraEvent(message, { expanded: true }, fakeTheme)).join("\n");

		expect(collapsed).toContain("the body text");
		expect(expanded).toContain("the body text");
	});

	test("event title is branded and accent-colored", () => {
		const theme = recordedTheme();
		const rendered = rows(renderHuddoraEvent({ content: "x" }, { expanded: true }, theme)).join("\n");

		expect(rendered).toContain(`${HUDDORA_GLYPH} ${HUDDORA_WORD} event`);
		expect(theme.seen).toContain("accent");
	});

	test("guidance title is dim and branded, compact when collapsed, full when expanded", () => {
		const theme = recordedTheme();
		const body = "guidance one\nguidance two";

		const collapsedRows = rows(renderHuddoraGuidance({ content: body }, { expanded: false }, theme));
		const expandedRows = rows(renderHuddoraGuidance({ content: body }, { expanded: true }, theme));
		const collapsedText = collapsedRows.join("\n");
		const expandedText = expandedRows.join("\n");

		expect(collapsedText).toContain(`${HUDDORA_GLYPH} ${HUDDORA_WORD} guidance`);
		expect(expandedText).toContain(`${HUDDORA_GLYPH} ${HUDDORA_WORD} guidance`);
		expect(collapsedText).toContain("guidance one");
		expect(collapsedText).not.toContain("guidance two");
		expect(expandedText).toContain("guidance two");
		expect(theme.seen).toContain("dim");
		expect(collapsedRows.length).toBeLessThan(expandedRows.length);
	});

	test("status renders accent branded title with full lobby-card content", () => {
		const theme = recordedTheme();
		const card = "Room: Slupport\nAgent: Alice OMP\nNext: /huddora connect";

		const rendered = rows(renderHuddoraStatus({ content: card }, { expanded: true }, theme)).join("\n");

		expect(rendered).toContain(`${HUDDORA_GLYPH} ${HUDDORA_WORD} status`);
		expect(rendered).toContain("Room: Slupport");
		expect(rendered).toContain("Next: /huddora connect");
		expect(theme.seen).toContain("accent");
	});

	test("flat content fallback — message content is preserved on the input", () => {
		// Renderers receive message by reference and must not mutate it.
		const message = { content: "do not touch me" };
		const before = message.content;

		renderHuddoraEvent(message, { expanded: true }, fakeTheme);
		renderHuddoraGuidance(message, { expanded: false }, fakeTheme);
		renderHuddoraStatus(message, { expanded: true }, fakeTheme);

		expect(message.content).toBe(before);
	});
});

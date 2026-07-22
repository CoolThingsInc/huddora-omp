import { describe, expect, test } from "bun:test";
import { HUDDORA_GLYPH, HUDDORA_WORD, HUD_STATE_LABELS } from "./brand";
import {
	deriveHudModel,
	formatHudStatusFallback,
	formatHudWidgetLines,
	type HudInput,
	type HudTheme,
} from "./hud";

const base: HudInput = {
	pluginVersion: "17.0.5",
	agentDisplayName: "Alice's OMP",
	selfAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	roomId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	roomName: "Slupport",
	presence: "online",
	paused: false,
	lastError: null,
};

const plainTheme: HudTheme = {
	fg: (_color, text) => text,
};

describe("HUD logic and formatters", () => {
	test("ready: online with room and not paused", () => {
		const model = deriveHudModel(base);
		expect(model.state).toBe("ready");
		expect(model.label).toBe(HUD_STATE_LABELS.ready);
		expect(model.color).toBe("success");

		const lines = formatHudWidgetLines(model, plainTheme);
		expect(lines).toHaveLength(2); // no next-action
		expect(lines[0]).toBe(`${HUDDORA_GLYPH} Huddora v17.0.5 — Ready`);
		expect(lines[1]).toBe("Slupport · Alice's OMP");

		const fallback = formatHudStatusFallback(model);
		expect(fallback).toBe(`${HUDDORA_GLYPH} Huddora v17.0.5 — Ready  Slupport · Alice's OMP`);
		expect(fallback).not.toMatch(/\x1b/); // no ANSI
	});

	test("setup: no room (wins over presence)", () => {
		const input = { ...base, roomId: null, roomName: null, presence: "offline" as const };
		const model = deriveHudModel(input);
		expect(model.state).toBe("setup");
		expect(model.label).toBe(HUD_STATE_LABELS.setup);

		const lines = formatHudWidgetLines(model, plainTheme);
		expect(lines).toHaveLength(3);
		expect(lines[1]).toBe("no room · Alice's OMP");
		expect(lines[2]).toBe("create or join a room, then /huddora room");
	});

	test("reconnect: preempt error with room and not paused", () => {
		const input = { ...base, lastError: "seat taken — preempted" };
		const model = deriveHudModel(input);
		expect(model.state).toBe("reconnect");

		const lines = formatHudWidgetLines(model, plainTheme);
		expect(lines).toHaveLength(3);
		expect(lines[2]).toBe("run /huddora connect");
	});

	test("away: offline presence (with room)", () => {
		const input = { ...base, presence: "offline" as const };
		const model = deriveHudModel(input);
		expect(model.state).toBe("away");

		const lines = formatHudWidgetLines(model, plainTheme);
		expect(lines).toHaveLength(3);
		expect(lines[2]).toBe("resume with /huddora resume");
	});

	test("paused: forces away state when online", () => {
		const input = { ...base, paused: true, presence: "online" as const };
		const model = deriveHudModel(input);
		expect(model.state).toBe("away");
		expect(model.paused).toBe(true);

		// Fallback includes the paused marker
		expect(formatHudStatusFallback(model)).toContain("paused");
	});

	test("revoked: presence or error triggers terminal state (wins over setup)", () => {
		const input = { ...base, roomId: null, presence: "revoked" as const };
		const model = deriveHudModel(input);
		expect(model.state).toBe("revoked");
		expect(model.color).toBe("error");

		const lines = formatHudWidgetLines(model, plainTheme);
		expect(lines).toHaveLength(3);
		expect(lines[2]).toContain("/huddora connect");
		expect(lines[2]).not.toContain("/huddora init");
		expect(lines[2]).toContain("re-authorize or recreate");
	});

	test("fallback contains no ANSI escapes and stays compact", () => {
		const input = { ...base, paused: true, lastError: "preempted" };
		const model = deriveHudModel(input);
		const fallback = formatHudStatusFallback(model);
		expect(fallback).not.toMatch(/\x1b/);
		expect(fallback.split("\n")).toHaveLength(1);
	});

	test("handles null gracefully (unregistered agent)", () => {
		const input = { ...base, agentDisplayName: null, selfAgentId: null };
		const model = deriveHudModel(input);
		expect(model.agent).toBe("unregistered agent");
	});
});

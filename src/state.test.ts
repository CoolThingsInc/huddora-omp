import { describe, expect, test } from "bun:test";
import {
	advanceCursor,
	markEmpty,
	markError,
	nextPollDelayMs,
	parseState,
	restoreStateFromBranch,
	toDurable,
} from "./state";
import { CUSTOM_STATE_TYPE, defaultState } from "./types";

describe("restoreStateFromBranch", () => {
	test("last wins", () => {
		const s = restoreStateFromBranch([
			{ type: "custom", customType: CUSTOM_STATE_TYPE, data: { roomId: "a", cursor: 1 } },
			{
				type: "custom",
				customType: CUSTOM_STATE_TYPE,
				data: { roomId: "b", cursor: 7, paused: true },
			},
		]);
		expect(s.roomId).toBe("b");
		expect(s.cursor).toBe(7);
		expect(s.paused).toBe(true);
	});
});

describe("cursor", () => {
	test("forward only + idempotent", () => {
		let s = { ...defaultState(), cursor: 10 };
		s = advanceCursor(s, { nextCursor: 5, maxMessageCursor: 8 });
		expect(s.cursor).toBe(10);
		s = advanceCursor(s, { nextCursor: 15, maxMessageCursor: 12 });
		expect(s.cursor).toBe(15);
		expect(advanceCursor(s, { nextCursor: 15, maxMessageCursor: 15 }).cursor).toBe(15);
	});
});

describe("pause durable", () => {
	test("round-trip", () => {
		const parsed = parseState(
			toDurable({ ...defaultState(), roomId: "r", paused: true, cursor: 2 }),
		);
		expect(parsed?.paused).toBe(true);
		expect(parsed?.cursor).toBe(2);
	});
});

describe("lastExtensionVersion durable", () => {
	test("round-trip and missing defaults null", () => {
		const parsed = parseState(
			toDurable({ ...defaultState(), lastExtensionVersion: "0.3.9", selfAgentId: "a" }),
		);
		expect(parsed?.lastExtensionVersion).toBe("0.3.9");
		expect(parseState({ roomId: "r" })?.lastExtensionVersion).toBe(null);
	});
});

describe("backoff", () => {
	test("grows", () => {
		const d0 = nextPollDelayMs({ ...defaultState(), errorStreak: 0 }, 1000, 8000, () => 1);
		const d3 = nextPollDelayMs({ ...defaultState(), errorStreak: 3 }, 1000, 8000, () => 1);
		expect(d3).toBeGreaterThan(d0);
		expect(markEmpty(defaultState()).emptyStreak).toBe(1);
		expect(markError(defaultState(), "x").errorStreak).toBe(1);
	});
});

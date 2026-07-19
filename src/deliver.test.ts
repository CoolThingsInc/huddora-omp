import { describe, expect, test } from "bun:test";
import {
	boundBatchForInject,
	chooseDeliverOptions,
	defaultRateGuard,
	gateInject,
	RATE_MAX_INJECTS_PER_MIN,
	RATE_STEER_MIN_MS,
	simpleBodyHash,
	truncateBody,
} from "./deliver";

describe("chooseDeliverOptions", () => {
	test("active → steer, no trigger", () => {
		expect(chooseDeliverOptions(false)).toEqual({ deliverAs: "steer", triggerTurn: false });
	});
	test("idle → nextTurn + triggerTurn", () => {
		expect(chooseDeliverOptions(true)).toEqual({ deliverAs: "nextTurn", triggerTurn: true });
	});
});

describe("gateInject", () => {
	test("dedupes identical body", () => {
		const g0 = defaultRateGuard();
		const r1 = gateInject(g0, { isIdle: true, content: "hello", now: 1000 });
		expect(r1?.options.deliverAs).toBe("nextTurn");
		const r2 = gateInject(r1!.guard, { isIdle: true, content: "hello", now: 2000 });
		expect(r2).toBeNull();
	});

	test("noise never wakes", () => {
		expect(gateInject(defaultRateGuard(), { isIdle: true, content: "x", noise: true })).toBeNull();
	});

	test("steer rate → followUp", () => {
		const g0 = defaultRateGuard();
		const r1 = gateInject(g0, { isIdle: false, content: "a", now: 10_000 });
		expect(r1?.options.deliverAs).toBe("steer");
		const r2 = gateInject(r1!.guard, {
			isIdle: false,
			content: "b",
			now: 10_000 + RATE_STEER_MIN_MS - 1,
		});
		expect(r2?.options.deliverAs).toBe("followUp");
	});

	test("per-minute cap drops idle wake", () => {
		let g = defaultRateGuard();
		const base = 1_000_000;
		for (let i = 0; i < RATE_MAX_INJECTS_PER_MIN; i++) {
			const r = gateInject(g, { isIdle: true, content: `m${i}`, now: base + i });
			expect(r).not.toBeNull();
			g = r!.guard;
		}
		const blocked = gateInject(g, {
			isIdle: true,
			content: "overflow",
			now: base + RATE_MAX_INJECTS_PER_MIN,
		});
		expect(blocked).toBeNull();
		const follow = gateInject(g, {
			isIdle: false,
			content: "overflow-stream",
			now: base + RATE_MAX_INJECTS_PER_MIN,
		});
		expect(follow?.options.deliverAs).toBe("followUp");
	});
});

describe("boundBatchForInject / truncateBody", () => {
	test("keeps newest by count", () => {
		const batch = [1, 2, 3, 4, 5].map((n) => ({ body: String(n) }));
		expect(boundBatchForInject(batch, 2).map((m) => m.body)).toEqual(["4", "5"]);
	});
	test("truncates middle", () => {
		const body = "a".repeat(100) + "MID" + "b".repeat(100);
		const t = truncateBody(body, 50);
		expect(t.length).toBeLessThan(body.length);
		expect(t).toContain("[truncated]");
	});
	test("hash stable", () => {
		expect(simpleBodyHash("x")).toBe(simpleBodyHash("x"));
		expect(simpleBodyHash("x")).not.toBe(simpleBodyHash("y"));
	});
});

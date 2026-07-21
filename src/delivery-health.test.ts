import { describe, expect, test } from "bun:test";
import {
	type DeliveryLightInput,
	deliveryLight,
	isCourierPrimary,
	PUSH_STARTUP_GRACE_MS,
	PUSH_STALE_MS,
	recoveryPollBaseMs,
	shouldUsePollRecovery,
} from "./delivery-health";

const NOW = 1_700_000_000_000;

describe("delivery-health", () => {
	test("isCourierPrimary is always true for this plugin", () => {
		expect(isCourierPrimary()).toBe(true);
	});

	test("constants are stable", () => {
		expect(PUSH_STALE_MS).toBe(45_000);
		expect(PUSH_STARTUP_GRACE_MS).toBe(60_000);
	});

	describe("shouldUsePollRecovery", () => {
		const startedAt = NOW;
		const base = {
			delivery: "bridge" as const,
			pushEnabled: true,
			startedAt,
		};

		test("no recovery when push disabled", () => {
			expect(
				shouldUsePollRecovery({ ...base, delivery: "poll", pushEnabled: false, lastPushAt: null, now: NOW }),
			).toBe(false);
		});

		test("no recovery when delivery not bridge", () => {
			expect(
				shouldUsePollRecovery({ ...base, delivery: "unavailable", pushEnabled: true, lastPushAt: null, now: NOW }),
			).toBe(false);
		});

		test("no recovery during startup grace even with no push yet", () => {
			expect(
				shouldUsePollRecovery({
					...base,
					lastPushAt: null,
					now: NOW + PUSH_STARTUP_GRACE_MS - 1,
				}),
			).toBe(false);
		});

		test("recovery kicks in after startup grace with no push", () => {
			expect(
				shouldUsePollRecovery({
					...base,
					lastPushAt: null,
					now: NOW + PUSH_STARTUP_GRACE_MS + 1,
				}),
			).toBe(true);
		});

		test("no recovery when last push is recent", () => {
			expect(
				shouldUsePollRecovery({
					...base,
					lastPushAt: NOW + 1_000,
					now: NOW + 10_000,
				}),
			).toBe(false);
		});

		test("recovery when last push older than PUSH_STALE_MS", () => {
			expect(
				shouldUsePollRecovery({
					...base,
					lastPushAt: NOW,
					now: NOW + PUSH_STALE_MS + 1,
				}),
			).toBe(true);
		});
	});

	describe("recoveryPollBaseMs", () => {
		test("pass-through when not recovering", () => {
			expect(recoveryPollBaseMs(false, 8_000)).toBe(8_000);
		});

		test("halves base while recovering", () => {
			expect(recoveryPollBaseMs(true, 8_000)).toBe(4_000);
		});

		test("floors tiny bases at 1000ms", () => {
			expect(recoveryPollBaseMs(true, 1_500)).toBe(1_000);
		});

		test("(defensive) zero/negative base floors and does not panic", () => {
			expect(recoveryPollBaseMs(true, 0)).toBe(1_000);
			expect(recoveryPollBaseMs(true, -500)).toBe(1_000);
		});
	});

	describe("deliveryLight", () => {
		const freshLease = NOW + 120_000;
		const recentPush = NOW - 5_000;

		const greenish: DeliveryLightInput = {
			bridgeReady: true,
			leaseExpiresAt: freshLease,
			lastPushAt: recentPush,
			now: NOW,
		};

		test("red when bridge not ready", () => {
			expect(deliveryLight({ ...greenish, bridgeReady: false })).toBe("red");
		});

		test("red when lease is null", () => {
			expect(deliveryLight({ ...greenish, leaseExpiresAt: null })).toBe("red");
		});

		test("red when lease expired", () => {
			expect(deliveryLight({ ...greenish, leaseExpiresAt: NOW - 1 })).toBe("red");
		});

		test("red when lease fresh but under one reclaim window", () => {
			expect(deliveryLight({ ...greenish, leaseExpiresAt: NOW + 30_000 })).toBe("red");
		});

		test("amber when lease fresh but no push at all", () => {
			expect(deliveryLight({ ...greenish, lastPushAt: null })).toBe("amber");
		});

		test("amber when push older than PUSH_STALE_MS", () => {
			expect(
				deliveryLight({ ...greenish, lastPushAt: NOW - PUSH_STALE_MS - 1 }),
			).toBe("amber");
		});

		test("green when lease fresh and push recent", () => {
			expect(deliveryLight({ ...greenish })).toBe("green");
		});

		test("green when push exactly at the stale threshold (boundary inclusive ok)", () => {
			expect(
				deliveryLight({ ...greenish, lastPushAt: NOW - PUSH_STALE_MS }),
			).toBe("green");
		});

		test("honors custom reclaimMs", () => {
			// lease 50s out: default 60s reclaim => red (not fresh); 10s reclaim => green
			const justFresh: DeliveryLightInput = {
				...greenish,
				leaseExpiresAt: NOW + 50_000,
			};
			expect(deliveryLight(justFresh)).toBe("red");
			expect(deliveryLight({ ...justFresh, reclaimMs: 10_000 })).toBe("green");
		});
	});
});

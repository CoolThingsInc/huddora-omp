/**
 * Pure delivery-health primitives: SSE push-staleness heuristics and the
 * deliveryLight status derived from lease freshness + bridge state.
 *
 * Content/cursor is never advanced from this module — it only shapes poll
 * density and surfaces a glanceable light. The durable pull path stays the
 * sole cursor authority.
 */

/** Push considered stale after this gap with no SSE wake (courier may be dark). */
export const PUSH_STALE_MS = 45_000;
/** Forgive missing first push during startup before flagging stale. */
export const PUSH_STARTUP_GRACE_MS = 60_000;

/** This plugin's transport is always bridge-courier primary (host seat model). */
export function isCourierPrimary(): boolean {
	return true;
}

export type ShouldUsePollRecoveryInput = {
	delivery: string;
	pushEnabled: boolean;
	lastPushAt: number | null;
	startedAt: number;
	now: number;
};

/**
 * Decide whether to densify polling because SSE pushes look stale.
 * Never advances a cursor — purely a poll-density hint.
 */
export function shouldUsePollRecovery(input: ShouldUsePollRecoveryInput): boolean {
	if (!input.pushEnabled || input.delivery !== "bridge") return false;
	if (input.lastPushAt == null) {
		// Forgive the startup window; after that a bridge with no pushes is dark.
		return input.now - input.startedAt > PUSH_STARTUP_GRACE_MS;
	}
	return input.now - input.lastPushAt > PUSH_STALE_MS;
}

/**
 * Halve the poll cadence while recovering via poll so we resync faster.
 * Guards keep the floor usable and never below half the base.
 */
export function recoveryPollBaseMs(usePollRecovery: boolean, pollBase: number): number {
	if (!usePollRecovery) return pollBase;
	const dense = Math.floor(pollBase / 2);
	return dense < 1_000 ? 1_000 : dense;
}

export type DeliveryLightInput = {
	bridgeReady: boolean;
	leaseExpiresAt: number | null;
	lastPushAt: number | null;
	now: number;
	/** Lease reclaim cadence; defaults to COURIER_RECLAIM_MS (60s). */
	reclaimMs?: number;
};

export type DeliveryLight = "green" | "amber" | "red";

/**
 * Glanceable delivery light from lease freshness + bridge + push recency.
 *
 * - red:   no bridge, or no/expired lease
 * - amber: lease fresh but no recent push (older than PUSH_STALE_MS, or null
 *          past startup grace)
 * - green: lease fresh and recent push (or within startup grace with lease)
 */
export function deliveryLight(input: DeliveryLightInput): DeliveryLight {
	if (!input.bridgeReady) return "red";
	if (input.leaseExpiresAt == null || input.leaseExpiresAt <= input.now) return "red";

	const reclaim = input.reclaimMs ?? 60_000;
	const leaseFresh = input.leaseExpiresAt - input.now > reclaim;
	if (!leaseFresh) return "red";

	if (input.lastPushAt == null) {
		return "amber";
	}
	if (input.now - input.lastPushAt > PUSH_STALE_MS) return "amber";
	return "green";
}

/**
 * Pure mid-turn delivery policy (no OMP imports).
 * Active → steer; idle → nextTurn + triggerTurn (wake once).
 */

export type DeliverAs = "steer" | "followUp" | "nextTurn";

export type DeliverOptions = {
	deliverAs: DeliverAs;
	triggerTurn: boolean;
};

export type RateGuardState = {
	/** Timestamps of recent injects (ms). */
	injectTimes: number[];
	/** Last steer timestamp (ms). */
	lastSteerAt: number;
	/** Last body fingerprint for identical-body suppress. */
	lastBodyHash: string | null;
};

export const RATE_STEER_MIN_MS = 2_000;
export const RATE_MAX_INJECTS_PER_MIN = 6;
export const BATCH_MAX_MESSAGES = 8;
export const BATCH_MAX_CHARS = 4_000;
export const DEBOUNCE_MS = 300;

export function chooseDeliverOptions(isIdle: boolean): DeliverOptions {
	if (!isIdle) {
		return { deliverAs: "steer", triggerTurn: false };
	}
	return { deliverAs: "nextTurn", triggerTurn: true };
}

export function simpleBodyHash(content: string): string {
	let h = 0;
	for (let i = 0; i < content.length; i++) {
		h = (h * 31 + content.charCodeAt(i)) | 0;
	}
	return String(h);
}

export function defaultRateGuard(): RateGuardState {
	return { injectTimes: [], lastSteerAt: 0, lastBodyHash: null };
}

/**
 * Returns null when inject should be dropped (rate / identical body).
 * Otherwise returns options + updated guard state.
 */
export function gateInject(
	guard: RateGuardState,
	opts: {
		isIdle: boolean;
		content: string;
		now?: number;
		/** Pure telemetry / empty batch — never wake. */
		noise?: boolean;
	},
): { options: DeliverOptions; guard: RateGuardState } | null {
	const now = opts.now ?? Date.now();
	if (opts.noise) return null;

	const hash = simpleBodyHash(opts.content);
	if (guard.lastBodyHash === hash) return null;

	const windowStart = now - 60_000;
	const recent = guard.injectTimes.filter((t) => t >= windowStart);
	if (recent.length >= RATE_MAX_INJECTS_PER_MIN) {
		// Over rate: only allow followUp park while streaming; never wake idle.
		if (opts.isIdle) return null;
		const options: DeliverOptions = { deliverAs: "followUp", triggerTurn: false };
		return {
			options,
			guard: {
				injectTimes: [...recent, now],
				lastSteerAt: guard.lastSteerAt,
				lastBodyHash: hash,
			},
		};
	}

	const base = chooseDeliverOptions(opts.isIdle);
	if (base.deliverAs === "steer" && now - guard.lastSteerAt < RATE_STEER_MIN_MS) {
		// Coalesce to followUp instead of hammering steer.
		return {
			options: { deliverAs: "followUp", triggerTurn: false },
			guard: {
				injectTimes: [...recent, now],
				lastSteerAt: guard.lastSteerAt,
				lastBodyHash: hash,
			},
		};
	}

	return {
		options: base,
		guard: {
			injectTimes: [...recent, now],
			lastSteerAt: base.deliverAs === "steer" ? now : guard.lastSteerAt,
			lastBodyHash: hash,
		},
	};
}

/** Bound a pending batch by message count and total body chars (keep newest). */
export function boundBatchForInject<T extends { body: string }>(
	messages: T[],
	maxMessages = BATCH_MAX_MESSAGES,
	maxChars = BATCH_MAX_CHARS,
): T[] {
	if (messages.length === 0) return messages;
	let batch =
		messages.length > maxMessages ? messages.slice(messages.length - maxMessages) : messages;
	let total = batch.reduce((n, m) => n + m.body.length, 0);
	while (batch.length > 1 && total > maxChars) {
		total -= batch[0]!.body.length;
		batch = batch.slice(1);
	}
	return batch;
}

/** Truncate middle of long body keeping head+tail. */
export function truncateBody(body: string, max = 4000): string {
	if (body.length <= max) return body;
	const head = Math.floor(max * 0.6);
	const tail = max - head - 20;
	return `${body.slice(0, head)}\n…[truncated]…\n${body.slice(body.length - Math.max(0, tail))}`;
}

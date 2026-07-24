/**
 * Pure mid-turn delivery policy (no OMP imports).
 * Active → steer; idle → nextTurn + triggerTurn (gated by triggerEligible).
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

/**
 * Minimal structural shape for direct-address classification (no full type import).
 * A message directly addresses this seat when:
 *   - mentions contains { kind: "agent", id: selfAgentId }, or
 *   - reply_to.actor_kind == "agent" && reply_to.agent_id == selfAgentId.
 * reply_to is only ever present with a complete parent identity (actor_kind +
 * agent_id); a malformed reply is rejected by the sanitizer before this runs.
 */
export type ClassifiableMessage = {
	mentions?: Array<{ kind: "human" | "agent"; id: string; name: string }>;
	reply_to?: {
		actor_kind: "human" | "agent";
		agent_id: string | null;
	} | null;
};

/** True iff `m` directly addresses the seat identified by `selfAgentId`. */
export function classifyDirect(m: ClassifiableMessage, selfAgentId: string | null): boolean {
	if (!selfAgentId) return false;
	if (Array.isArray(m.mentions)) {
		for (const ment of m.mentions) {
			if (ment && ment.kind === "agent" && ment.id === selfAgentId) return true;
		}
	}
	const rt = m.reply_to;
	if (rt && rt.actor_kind === "agent" && rt.agent_id && rt.agent_id === selfAgentId) {
		return true;
	}
	return false;
}

/** A pulled batch is trigger-eligible iff ANY message directly addresses this seat. */
export function isDirectBatch(messages: ClassifiableMessage[], selfAgentId: string | null): boolean {
	if (!selfAgentId) return false;
	for (const m of messages) {
		if (classifyDirect(m, selfAgentId)) return true;
	}
	return false;
}
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
 *
 * `triggerEligible` (default true): when false, an idle ambient batch is injected
 * as context WITHOUT a turn trigger (no wake). Active sessions keep steer/followUp
 * regardless — context can steer an ongoing turn. A reply_to with missing
 * parent identity is rejected by the sanitizer upstream (clean cutover), so
 * only well-identified messages reach a classifier; ambient stays `triggerEligible:false`.
 */
export function gateInject(
	guard: RateGuardState,
	opts: {
		isIdle: boolean;
		content: string;
		now?: number;
		/** Pure telemetry / empty batch — never wake. */
		noise?: boolean;
		/** Batch classified as directly addressing this seat. Default true. */
		triggerEligible?: boolean;
	},
): { options: DeliverOptions; guard: RateGuardState } | null {
	const now = opts.now ?? Date.now();
	if (opts.noise) return null;

	const triggerEligible = opts.triggerEligible !== false;

	const hash = simpleBodyHash(opts.content);
	if (guard.lastBodyHash === hash) return null;

	const windowStart = now - 60_000;
	const recent = guard.injectTimes.filter((t) => t >= windowStart);
	// The per-minute cap bounds WAKES, not context-only injections: ambient
	// idle batches never consume a slot (handled below), so the cap is only
	// ever reached by genuine direct/eligible wakes — preserving both the
	// existing backpressure and a direct wake that arrives after a stream of
	// ambient context injections (which left the counter at zero).
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

	// Idle ambient batch (no direct address): inject context, do NOT trigger a
	// turn AND do NOT consume the wake budget — otherwise six ambient batches
	// could starve the next direct eligible idle wake (see ambient-then-direct).
	let options = base;
	const isAmbientIdleContext = opts.isIdle && base.deliverAs === "nextTurn" && !triggerEligible;
	if (isAmbientIdleContext) {
		options = { deliverAs: "nextTurn", triggerTurn: false };
	}

	return {
		options,
		guard: {
			injectTimes: isAmbientIdleContext ? recent : [...recent, now],
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

import { CUSTOM_STATE_TYPE, defaultState, type HuddoraPluginState } from "./types";

type BranchEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
};

/** Rebuild durable plugin state from session branch (last wins). */
export function restoreStateFromBranch(entries: readonly BranchEntry[]): HuddoraPluginState {
	let latest: HuddoraPluginState | null = null;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === CUSTOM_STATE_TYPE) {
			const parsed = parseState(entry.data);
			if (parsed) latest = parsed;
		}
	}
	return latest ?? defaultState();
}

export function parseState(data: unknown): HuddoraPluginState | null {
	if (!data || typeof data !== "object") return null;
	const d = data as Record<string, unknown>;
	const base = defaultState();
	return {
		roomId: asNullableString(d.roomId) ?? base.roomId,
		roomName: asNullableString(d.roomName) ?? base.roomName,
		cursor: asNonNegInt(d.cursor) ?? base.cursor,
		paused: typeof d.paused === "boolean" ? d.paused : base.paused,
		pushEnabled: typeof d.pushEnabled === "boolean" ? d.pushEnabled : base.pushEnabled,
		selfUserId: asNullableString(d.selfUserId) ?? base.selfUserId,
		selfDisplayName: asNullableString(d.selfDisplayName) ?? base.selfDisplayName,
		selfAgentId: asNullableString(d.selfAgentId) ?? base.selfAgentId,
		agentDisplayName: asNullableString(d.agentDisplayName) ?? base.agentDisplayName,
		lastError: asNullableString(d.lastError) ?? base.lastError,
		lastSyncAt: asNullableString(d.lastSyncAt) ?? base.lastSyncAt,
		emptyStreak: asNonNegInt(d.emptyStreak) ?? base.emptyStreak,
		errorStreak: asNonNegInt(d.errorStreak) ?? base.errorStreak,
	};
}

/** Durable payload only (no ephemeral streaks required, but we persist them). */
export function toDurable(state: HuddoraPluginState): HuddoraPluginState {
	return {
		roomId: state.roomId,
		roomName: state.roomName,
		cursor: state.cursor,
		paused: state.paused,
		pushEnabled: state.pushEnabled,
		selfUserId: state.selfUserId,
		selfDisplayName: state.selfDisplayName,
		selfAgentId: state.selfAgentId,
		agentDisplayName: state.agentDisplayName,
		lastError: state.lastError,
		lastSyncAt: state.lastSyncAt,
		emptyStreak: state.emptyStreak,
		errorStreak: state.errorStreak,
	};
}

/**
 * Advance cursor only after successful durable handling.
 * Prefer nextCursor from server; else max message cursor.
 */
export function advanceCursor(
	state: HuddoraPluginState,
	opts: { nextCursor: number | null; maxMessageCursor: number | null },
): HuddoraPluginState {
	let cursor = state.cursor;
	if (opts.nextCursor !== null && opts.nextCursor > cursor) {
		cursor = opts.nextCursor;
	} else if (opts.maxMessageCursor !== null && opts.maxMessageCursor > cursor) {
		cursor = opts.maxMessageCursor;
	}
	return {
		...state,
		cursor,
		emptyStreak: 0,
		errorStreak: 0,
		lastError: null,
		lastSyncAt: new Date().toISOString(),
	};
}

export function markEmpty(state: HuddoraPluginState): HuddoraPluginState {
	return {
		...state,
		emptyStreak: state.emptyStreak + 1,
		errorStreak: 0,
		lastError: null,
		lastSyncAt: new Date().toISOString(),
	};
}

export function markError(state: HuddoraPluginState, message: string): HuddoraPluginState {
	return {
		...state,
		errorStreak: state.errorStreak + 1,
		lastError: message.slice(0, 500),
		lastSyncAt: new Date().toISOString(),
	};
}

/** Backoff delay with full jitter. */
export function nextPollDelayMs(
	state: HuddoraPluginState,
	baseMs: number,
	maxMs: number,
	random: () => number = Math.random,
): number {
	const streak = Math.max(state.emptyStreak, state.errorStreak);
	const exp = Math.min(maxMs, baseMs * 2 ** Math.min(streak, 4));
	// full jitter: [0.5, 1.0] * exp
	const jitter = 0.5 + random() * 0.5;
	return Math.max(baseMs, Math.floor(exp * jitter));
}

function asNullableString(v: unknown): string | null | undefined {
	if (v === null) return null;
	if (typeof v === "string") return v;
	return undefined;
}

function asNonNegInt(v: unknown): number | undefined {
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
	return Math.floor(v);
}

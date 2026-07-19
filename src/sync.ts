import { boundMessages, filterOwnMessages, formatRoomChatInjection, maxCursor } from "./format";
import { mcpMessageHistory, mcpRoomSnapshot } from "./mcp-client";
import { advanceCursor, markEmpty, markError, toDurable } from "./state";
import type { HuddoraPluginState, RoomMessage } from "./types";
import { INJECT_LIMIT, LONG_POLL_MS } from "./types";

export type SyncOutcome =
	| {
			kind: "injected";
			state: HuddoraPluginState;
			content: string;
			messageCount: number;
			/** Cursor after successful handling. */
			cursorAfter: number;
	  }
	| { kind: "empty"; state: HuddoraPluginState }
	| { kind: "error"; state: HuddoraPluginState; message: string }
	| { kind: "no_room"; state: HuddoraPluginState };

/**
 * Pull messages after cursor, filter own, bound, format injection text.
 * Does NOT mutate session — caller persists cursor only after successful inject.
 */
export async function pullAndFormat(
	state: HuddoraPluginState,
	opts: {
		limit?: number;
		waitMs?: number;
		/** Include own messages (manual sync may want them). Default false. */
		includeOwn?: boolean;
		signal?: AbortSignal;
	} = {},
): Promise<SyncOutcome> {
	if (!state.roomId) {
		return { kind: "no_room", state };
	}

	const limit = opts.limit ?? INJECT_LIMIT;
	const res = await mcpMessageHistory(
		{
			roomId: state.roomId,
			afterCursor: state.cursor,
			limit,
			waitMs: opts.waitMs,
		},
		opts.signal,
	);

	if (!res.ok) {
		return {
			kind: "error",
			state: markError(state, res.error.message),
			message: res.error.message,
		};
	}

	let messages = res.data.messages;
	if (!opts.includeOwn) {
		messages = filterOwnMessages(messages, state.selfUserId, state.selfAgentId);
	}
	messages = boundMessages(messages, limit);
	if (messages.length === 0) {
		// Still advance if server reported next_cursor past us with only own msgs filtered out.
		const maxAll = maxCursor(res.data.messages);
		const next = res.data.next_cursor;
		if ((next !== null && next > state.cursor) || (maxAll !== null && maxAll > state.cursor)) {
			const advanced = advanceCursor(state, {
				nextCursor: next,
				maxMessageCursor: maxAll,
			});
			return { kind: "empty", state: advanced };
		}
		return { kind: "empty", state: markEmpty(state) };
	}

	const cursorAfter =
		res.data.next_cursor ?? maxCursor(messages) ?? maxCursor(res.data.messages) ?? state.cursor;

	const content = formatRoomChatInjection({
		roomId: state.roomId,
		roomName: state.roomName,
		messages,
		cursorAfter,
	});

	const advanced = advanceCursor(state, {
		nextCursor: res.data.next_cursor,
		maxMessageCursor: maxCursor(res.data.messages),
	});

	return {
		kind: "injected",
		state: advanced,
		content,
		messageCount: messages.length,
		cursorAfter: advanced.cursor,
	};
}

/** Bootstrap room binding: snapshot membership + set cursor to latest (no replay flood). */
export async function bootstrapRoom(
	state: HuddoraPluginState,
	roomId: string,
	signal?: AbortSignal,
): Promise<
	| { ok: true; state: HuddoraPluginState; recent: RoomMessage[] }
	| { ok: false; state: HuddoraPluginState; message: string }
> {
	const snap = await mcpRoomSnapshot(roomId, 5, signal);
	if (!snap.ok) {
		return {
			ok: false,
			state: markError(state, snap.error.message),
			message: snap.error.message,
		};
	}

	const data = snap.data;
	const latest = data.latest_cursor ?? maxCursor(data.messages) ?? 0;
	const next: HuddoraPluginState = {
		...state,
		roomId: data.room.room_id,
		roomName: data.room.name,
		cursor: latest,
		selfUserId: data.membership.user_id,
		selfDisplayName: data.membership.display_name,
		paused: false,
		lastError: null,
		emptyStreak: 0,
		errorStreak: 0,
		lastSyncAt: new Date().toISOString(),
	};

	return { ok: true, state: next, recent: data.messages };
}

export function durablePayload(state: HuddoraPluginState): HuddoraPluginState {
	return toDurable(state);
}

/** Long-poll wait: use server max only when not paused and room set. */
export function longPollWaitMs(paused: boolean): number | undefined {
	if (paused) return undefined;
	return LONG_POLL_MS;
}

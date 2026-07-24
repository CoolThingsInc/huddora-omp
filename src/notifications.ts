import type { RoomMessage } from "./types";

export const HUDDORA_MESSAGES_METHOD = "notifications/huddora/messages";
export const HUDDORA_AGENT_METHOD = "notifications/huddora/agent";

export type HuddoraMessagesNotification = {
	roomId: string;
	messages: RoomMessage[];
	nextCursor: number | null;
};

export type HuddoraAgentRenamedNotification = {
	type: "agent_renamed";
	agentId: string;
	displayName: string;
};

export type HuddoraAgentPreemptedNotification = {
	type: "agent_preempted";
	agentId: string;
	reason: "bound_elsewhere";
	bySessionId: string | null;
};

export type HuddoraAgentNotification =
	| HuddoraAgentRenamedNotification
	| HuddoraAgentPreemptedNotification;

/**
 * Defensively parse a single room message from untrusted wire input.
 * Returns null when required fields (cursor/body) are missing or structurally
 * invalid. `author_id` may legitimately be null (Huddora retains former-member
 * / deleted-account messages with author_id null); such rows are kept.
 * Validates mentions and reply_to so malformed values cannot masquerade as a
 * structured self-mention or reply-to-self. Reused by both the SSE push
 * notification parser and the durable `message_history`/`room_snapshot` paths.
 */
export function parseRoomMessage(raw: unknown, fallbackRoomId: string): RoomMessage | null {
	if (!raw || typeof raw !== "object") return null;
	const cursor = Reflect.get(raw, "cursor");
	const body = Reflect.get(raw, "body");
	const authorId = Reflect.get(raw, "author_id");
	if (
		typeof cursor !== "number" ||
		typeof body !== "string" ||
		(authorId !== null && typeof authorId !== "string")
	) {
		return null;
	}
	const actorKind = stringField(raw, "actor_kind");
	const msg: RoomMessage = {
		message_id: stringField(raw, "message_id") ?? `c-${cursor}`,
		room_id: stringField(raw, "room_id") ?? fallbackRoomId,
		cursor,
		author_id: authorId,
		author_name: stringField(raw, "author_name") ?? (authorId ? authorId.slice(0, 8) : "unknown"),
		body,
		client_message_id: stringField(raw, "client_message_id") ?? `c-${cursor}`,
		created_at: stringField(raw, "created_at") ?? "",
		actor_kind: actorKind === "agent" || actorKind === "human" ? actorKind : "human",
		agent_id: stringField(raw, "agent_id"),
		agent_name: stringField(raw, "agent_name"),
		owner_id: stringField(raw, "owner_id") ?? authorId,
		owner_name: stringField(raw, "owner_name"),
	};
	const replyTo = parseReplyTo(raw);
	// Malformed reply_to (present object missing required parent identity) fails
	// the whole message: it must not be classified as ambient or direct. Pull is
	// authoritative and cursor-safe; SSE push may drop it on the floor.
	if (replyTo === REPLY_PARSE_FAILED) return null;
	if (replyTo !== undefined) msg.reply_to = replyTo;
	const mentions = parseMentions(raw);
	if (mentions !== undefined) msg.mentions = mentions;
	return msg;
}

/** Result of parsing a raw message array: kept messages plus a count of entries
 *  that failed structural validation. A non-zero errorCount means the page was
 *  partially malformed; durable consumers must fail the page (never advance the
 *  cursor past unseen content) rather than silently dropping rows. */
export type ParseRoomMessagesResult = {
	messages: RoomMessage[];
	errorCount: number;
};

/** Parse an array of raw message values into validated RoomMessage[], also
 *  reporting how many entries failed structural validation (malformed).
 *  A null author_id is valid (former-member/deleted-account retention) and is
 *  NOT counted as an error. */
export function parseRoomMessages(raw: unknown, fallbackRoomId: string): ParseRoomMessagesResult {
	if (!Array.isArray(raw)) return { messages: [], errorCount: 0 };
	const messages: RoomMessage[] = [];
	let errorCount = 0;
	for (const entry of raw) {
		const msg = parseRoomMessage(entry, fallbackRoomId);
		if (msg) messages.push(msg);
		else errorCount++;
	}
	return { messages, errorCount };
}
/** Parse custom MCP notification; ignore unknown methods. */
export function parseHuddoraMessagesNotification(
	method: string,
	params: unknown,
): HuddoraMessagesNotification | null {
	if (method !== HUDDORA_MESSAGES_METHOD) return null;
	if (!params || typeof params !== "object") return null;
	const roomId = Reflect.get(params, "room_id");
	const messages = Reflect.get(params, "messages");
	const next = Reflect.get(params, "next_cursor");
	if (typeof roomId !== "string" || !Array.isArray(messages)) return null;
	const parsed = parseRoomMessages(messages, roomId);
	return {
		roomId,
		messages: parsed.messages,
		nextCursor: typeof next === "number" && Number.isFinite(next) ? next : null,
	};
}

/** Parse agent lifecycle push: rename + preempt. */
export function parseHuddoraAgentNotification(
	method: string,
	params: unknown,
): HuddoraAgentNotification | null {
	if (method !== HUDDORA_AGENT_METHOD) return null;
	if (!params || typeof params !== "object") return null;
	const type = Reflect.get(params, "type");
	const agentId = Reflect.get(params, "agent_id");
	if (typeof agentId !== "string" || !agentId.trim()) return null;

	if (type === "agent_renamed") {
		const displayName = Reflect.get(params, "display_name");
		if (typeof displayName !== "string" || !displayName.trim()) return null;
		return {
			type: "agent_renamed",
			agentId: agentId.trim(),
			displayName: displayName.trim(),
		};
	}

	if (type === "agent_preempted") {
		const reason = Reflect.get(params, "reason");
		const by = Reflect.get(params, "by_session_id");
		return {
			type: "agent_preempted",
			agentId: agentId.trim(),
			reason: reason === "bound_elsewhere" ? "bound_elsewhere" : "bound_elsewhere",
			bySessionId: typeof by === "string" && by.trim() ? by.trim() : null,
		};
	}

	return null;
}


/** Sentinel: a present reply_to object failed contract validation (missing/invalid
 *  message_id/cursor, or missing/invalid parent actor_kind/agent_id). Makes the
 *  enclosing message fail parsing — never collapses to ambient or null. */
const REPLY_PARSE_FAILED = Symbol("reply_parse_failed");

function parseReplyTo(
	raw: object,
): typeof REPLY_PARSE_FAILED | RoomMessage["reply_to"] | undefined {
	if (!Object.prototype.hasOwnProperty.call(raw, "reply_to")) return undefined;
	const rt = Reflect.get(raw, "reply_to");
	if (rt == null) return null;
	if (typeof rt !== "object") return REPLY_PARSE_FAILED;
	const message_id = Reflect.get(rt, "message_id");
	const cursor = Reflect.get(rt, "cursor");
	if (
		typeof message_id !== "string" ||
		!message_id ||
		typeof cursor !== "number" ||
		!Number.isFinite(cursor)
	) {
		return REPLY_PARSE_FAILED;
	}
	const author_name = Reflect.get(rt, "author_name");
	const snippet = Reflect.get(rt, "snippet");
	const actorKind = Reflect.get(rt, "actor_kind");
	const agentId = Reflect.get(rt, "agent_id");
	// Parent identity is mandatory whenever a reply_to object is present.
	// actor_kind must be human|agent; agent_id must be a non-empty string for a
	// live agent parent or null for a human/deleted-agent parent.
	if (actorKind !== "agent" && actorKind !== "human") return REPLY_PARSE_FAILED;
	if (agentId !== null && (typeof agentId !== "string" || !agentId)) return REPLY_PARSE_FAILED;
	return {
		message_id,
		cursor,
		author_name: typeof author_name === "string" ? author_name : "",
		snippet: typeof snippet === "string" ? snippet.slice(0, 80) : "",
		actor_kind: actorKind,
		agent_id: agentId,
	};
}

function parseMentions(
	raw: object,
): Array<{ kind: "human" | "agent"; id: string; name: string }> | undefined {
	if (!Object.prototype.hasOwnProperty.call(raw, "mentions")) return undefined;
	const list = Reflect.get(raw, "mentions");
	if (!Array.isArray(list)) return [];
	const out: Array<{ kind: "human" | "agent"; id: string; name: string }> = [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const kind = Reflect.get(item, "kind");
		const id = Reflect.get(item, "id");
		const name = Reflect.get(item, "name");
		if ((kind !== "human" && kind !== "agent") || typeof id !== "string" || !id) continue;
		if (typeof name !== "string") continue;
		out.push({ kind, id, name });
	}
	return out;
}
function stringField(raw: object, key: string): string | null {
	const v = Reflect.get(raw, key);
	return typeof v === "string" ? v : null;
}

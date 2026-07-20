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
	const parsed: RoomMessage[] = [];
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const cursor = Reflect.get(raw, "cursor");
		const body = Reflect.get(raw, "body");
		const authorId = Reflect.get(raw, "author_id");
		if (typeof cursor !== "number" || typeof body !== "string" || typeof authorId !== "string") {
			continue;
		}
		const actorKind = stringField(raw, "actor_kind");
		const msg: RoomMessage = {
			message_id: stringField(raw, "message_id") ?? `c-${cursor}`,
			room_id: stringField(raw, "room_id") ?? roomId,
			cursor,
			author_id: authorId,
			author_name: stringField(raw, "author_name") ?? authorId.slice(0, 8),
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
		if (replyTo !== undefined) msg.reply_to = replyTo;
		const mentions = parseMentions(raw);
		if (mentions !== undefined) msg.mentions = mentions;
		parsed.push(msg);
	}
	return {
		roomId,
		messages: parsed,
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


function parseReplyTo(raw: object): RoomMessage["reply_to"] | undefined {
	if (!Object.prototype.hasOwnProperty.call(raw, "reply_to")) return undefined;
	const rt = Reflect.get(raw, "reply_to");
	if (rt == null) return null;
	if (typeof rt !== "object") return null;
	const message_id = Reflect.get(rt, "message_id");
	const cursor = Reflect.get(rt, "cursor");
	if (
		typeof message_id !== "string" ||
		!message_id ||
		typeof cursor !== "number" ||
		!Number.isFinite(cursor)
	) {
		return null;
	}
	const author_name = Reflect.get(rt, "author_name");
	const snippet = Reflect.get(rt, "snippet");
	return {
		message_id,
		cursor,
		author_name: typeof author_name === "string" ? author_name : "",
		snippet: typeof snippet === "string" ? snippet.slice(0, 80) : "",
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

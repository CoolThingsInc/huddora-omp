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
		parsed.push({
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
		});
	}
	return {
		roomId,
		messages: parsed,
		nextCursor: typeof next === "number" && Number.isFinite(next) ? next : null,
	};
}

/** Parse agent lifecycle push; only agent_renamed for now. */
export function parseHuddoraAgentNotification(
	method: string,
	params: unknown,
): HuddoraAgentRenamedNotification | null {
	if (method !== HUDDORA_AGENT_METHOD) return null;
	if (!params || typeof params !== "object") return null;
	const type = Reflect.get(params, "type");
	if (type !== "agent_renamed") return null;
	const agentId = Reflect.get(params, "agent_id");
	const displayName = Reflect.get(params, "display_name");
	if (typeof agentId !== "string" || !agentId.trim()) return null;
	if (typeof displayName !== "string" || !displayName.trim()) return null;
	return {
		type: "agent_renamed",
		agentId: agentId.trim(),
		displayName: displayName.trim(),
	};
}

function stringField(raw: object, key: string): string | null {
	const v = Reflect.get(raw, key);
	return typeof v === "string" ? v : null;
}

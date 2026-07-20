import { describe, expect, test } from "bun:test";
import {
	HUDDORA_AGENT_METHOD,
	HUDDORA_MESSAGES_METHOD,
	parseHuddoraAgentNotification,
	parseHuddoraMessagesNotification,
} from "./notifications";

describe("parseHuddoraMessagesNotification", () => {
	test("parses valid payload", () => {
		const p = parseHuddoraMessagesNotification(HUDDORA_MESSAGES_METHOD, {
			room_id: "r1",
			next_cursor: 3,
			messages: [
				{
					message_id: "m1",
					room_id: "r1",
					cursor: 3,
					author_id: "a1",
					author_name: "Bob",
					body: "hi",
					client_message_id: "c1",
					created_at: "t",
				},
			],
		});
		expect(p?.roomId).toBe("r1");
		expect(p?.messages[0]?.body).toBe("hi");
		expect(p?.nextCursor).toBe(3);
	});

	test("parses reply_to and mentions defensively", () => {
		const p = parseHuddoraMessagesNotification(HUDDORA_MESSAGES_METHOD, {
			room_id: "r1",
			next_cursor: 4,
			messages: [
				{
					message_id: "m2",
					room_id: "r1",
					cursor: 4,
					author_id: "a2",
					author_name: "Carol",
					body: "@Alice hi",
					client_message_id: "c2",
					created_at: "t",
					reply_to: {
						message_id: "m1",
						cursor: 3,
						author_name: "Bob",
						snippet: "hello",
					},
					mentions: [
						{ kind: "human", id: "h1", name: "Alice" },
						{ kind: "nope", id: "x", name: "bad" },
						{ kind: "agent", id: "ag1", name: "Bot" },
						null,
					],
				},
			],
		});
		expect(p?.messages[0]?.reply_to).toEqual({
			message_id: "m1",
			cursor: 3,
			author_name: "Bob",
			snippet: "hello",
		});
		expect(p?.messages[0]?.mentions).toEqual([
			{ kind: "human", id: "h1", name: "Alice" },
			{ kind: "agent", id: "ag1", name: "Bot" },
		]);
	});

	test("null reply_to and missing fields stay lean", () => {
		const p = parseHuddoraMessagesNotification(HUDDORA_MESSAGES_METHOD, {
			room_id: "r1",
			messages: [
				{
					message_id: "m1",
					cursor: 1,
					author_id: "a1",
					body: "x",
					reply_to: null,
					mentions: [],
				},
			],
		});
		expect(p?.messages[0]?.reply_to).toBeNull();
		expect(p?.messages[0]?.mentions).toEqual([]);
	});

	test("ignores resources/updated", () => {
		expect(
			parseHuddoraMessagesNotification("notifications/resources/updated", { uri: "x" }),
		).toBeNull();
	});
});

describe("parseHuddoraAgentNotification", () => {
	test("parses agent_renamed", () => {
		const p = parseHuddoraAgentNotification(HUDDORA_AGENT_METHOD, {
			type: "agent_renamed",
			agent_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			display_name: "bebrik",
		});
		expect(p).toEqual({
			type: "agent_renamed",
			agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			displayName: "bebrik",
		});
	});

	test("parses agent_preempted", () => {
		const p = parseHuddoraAgentNotification(HUDDORA_AGENT_METHOD, {
			type: "agent_preempted",
			agent_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			reason: "bound_elsewhere",
			by_session_id: "mcp-session-new",
		});
		expect(p).toEqual({
			type: "agent_preempted",
			agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			reason: "bound_elsewhere",
			bySessionId: "mcp-session-new",
		});
	});

	test("ignores other methods and types", () => {
		expect(parseHuddoraAgentNotification(HUDDORA_MESSAGES_METHOD, { type: "agent_renamed" })).toBeNull();
		expect(
			parseHuddoraAgentNotification(HUDDORA_AGENT_METHOD, {
				type: "agent_online",
				agent_id: "a",
				display_name: "x",
			}),
		).toBeNull();
		expect(
			parseHuddoraAgentNotification(HUDDORA_AGENT_METHOD, {
				type: "agent_renamed",
				agent_id: "",
				display_name: "x",
			}),
		).toBeNull();
	});
});

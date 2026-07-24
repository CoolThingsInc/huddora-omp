import { describe, expect, test } from "bun:test";
import {
	HUDDORA_AGENT_METHOD,
	HUDDORA_MESSAGES_METHOD,
	parseHuddoraAgentNotification,
	parseHuddoraMessagesNotification,
	parseRoomMessages,
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
					actor_kind: "agent",
					agent_id: "ag-parent",
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
			actor_kind: "agent",
			agent_id: "ag-parent",
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

describe("parseRoomMessages — shared durable sanitization authority", () => {
	// Locks the parser extracted from parseHuddoraMessagesNotification, now
	// reused by the durable message_history path so malformed mention/reply
	// identity cannot be classified as a structured self-mention.
	const SELF = "agent-self-id";

	test("drops a mention missing the required name (no false self-identification)", () => {
		const out = parseRoomMessages(
			[
				{
					message_id: "m1",
					room_id: "r1",
					cursor: 1,
					author_id: "a1",
					body: "hey",
					mentions: [{ kind: "agent", id: SELF }],
				},
			],
			"r1",
		);
		expect(out.messages).toHaveLength(1);
		// The malformed mention is dropped entirely — no self identification.
		expect(out.messages[0]?.mentions).toEqual([]);
		expect(out.messages[0]?.body).toBe("hey");
	});

	test("drops a mention with a non-string name", () => {
		const out = parseRoomMessages(
			[
				{
					cursor: 2,
					author_id: "a1",
					body: "x",
					mentions: [{ kind: "agent", id: SELF, name: 42 }],
				},
			],
			"r1",
		);
		expect(out.errorCount).toBe(0);
		expect(out.messages[0]?.mentions).toEqual([]);
	});

	test("keeps a mention with kind other than human/agent dropped but valid ones kept", () => {
		const out = parseRoomMessages(
			[
				{
					cursor: 3,
					author_id: "a1",
					body: "x",
					mentions: [
						{ kind: "agent", id: SELF, name: "me" },
						{ kind: "bot", id: "b", name: "bad" },
						{ kind: "human", id: "h1", name: "Alice" },
						null,
					],
				},
			],
			"r1",
		);
		expect(out.messages[0]?.mentions).toEqual([
			{ kind: "agent", id: SELF, name: "me" },
			{ kind: "human", id: "h1", name: "Alice" },
		]);
	});

	test("reply_to missing actor_kind fails the message (parse error, not ambient)", () => {
		// Clean cutover: identity is mandatory when reply_to is present.
		const out = parseRoomMessages(
			[
				{
					cursor: 4,
					author_id: "a1",
					body: "reply",
					reply_to: {
						message_id: "m-0",
						cursor: 0,
						author_name: "p",
						snippet: "s",
						agent_id: "ag-parent",
						// actor_kind missing => malformed identity.
					},
				},
			],
			"r1",
		);
		expect(out.messages).toHaveLength(0);
		expect(out.errorCount).toBe(1);
	});

	test("reply_to missing agent_id fails the message (parse error, not ambient)", () => {
		const out = parseRoomMessages(
			[
				{
					cursor: 5,
					author_id: "a1",
					body: "reply",
					reply_to: {
						message_id: "m-0",
						cursor: 0,
						author_name: "p",
						snippet: "s",
						actor_kind: "agent",
						// agent_id missing => malformed identity.
					},
				},
			],
			"r1",
		);
		expect(out.messages).toHaveLength(0);
		expect(out.errorCount).toBe(1);
	});

	test("reply_to with non-string non-null agent_id fails the message (parse error)", () => {
		const out = parseRoomMessages(
			[
				{
					cursor: 6,
					author_id: "a1",
					body: "reply",
					reply_to: {
						message_id: "m-0",
						cursor: 0,
						author_name: "p",
						snippet: "s",
						actor_kind: "agent",
						agent_id: 42,
					},
				},
			],
			"r1",
		);
		expect(out.messages).toHaveLength(0);
		expect(out.errorCount).toBe(1);
	});

	test("reply_to human parent with agent_id:null is valid (clean cutover)", () => {
		// agent_id is null for a human or deleted-agent parent — allowed.
		const out = parseRoomMessages(
			[
				{
					cursor: 7,
					author_id: "a1",
					body: "reply to human",
					reply_to: {
						message_id: "m-0",
						cursor: 0,
						author_name: "p",
						snippet: "s",
						actor_kind: "human",
						agent_id: null,
					},
				},
			],
			"r1",
		);
		expect(out.errorCount).toBe(0);
		expect(out.messages).toHaveLength(1);
		expect(out.messages[0]?.reply_to).toEqual({
			message_id: "m-0",
			cursor: 0,
			author_name: "p",
			snippet: "s",
			actor_kind: "human",
			agent_id: null,
		});
	});

	test("reply_to agent parent with live agent_id is valid", () => {
		const out = parseRoomMessages(
			[
				{
					cursor: 8,
					author_id: "a1",
					body: "reply to agent",
					reply_to: {
						message_id: "m-0",
						cursor: 0,
						author_name: "p",
						snippet: "s",
						actor_kind: "agent",
						agent_id: "ag-parent",
					},
				},
			],
			"r1",
		);
		expect(out.errorCount).toBe(0);
		expect(out.messages[0]?.reply_to?.agent_id).toBe("ag-parent");
		expect(out.messages[0]?.reply_to?.actor_kind).toBe("agent");
	});

	test("reply_to present but empty agent_id string fails (parse error)", () => {
		// agent_id must be null OR a non-empty string; "" is neither.
		const out = parseRoomMessages(
			[
				{
					cursor: 9,
					author_id: "a1",
					body: "reply",
					reply_to: {
						message_id: "m-0",
						cursor: 0,
						author_name: "p",
						snippet: "s",
						actor_kind: "agent",
						agent_id: "",
					},
				},
			],
			"r1",
		);
		expect(out.messages).toHaveLength(0);
		expect(out.errorCount).toBe(1);
	});

	test("malformed reply_to sibling fails the whole page (no cursor advance) sibling kept", () => {
		// One malformed identity + one valid sibling: malformed counts as error,
		// durable caller fails the page entirely; valid sibling survives parsing.
		const out = parseRoomMessages(
			[
				{
					cursor: 10,
					author_id: "a1",
					body: "bad reply",
					reply_to: { message_id: "m", cursor: 1, author_name: "p", snippet: "s" },
				},
				{ cursor: 11, author_id: "a2", body: "good sibling" },
			],
			"r1",
		);
		expect(out.errorCount).toBe(1);
		expect(out.messages.map((m) => m.body)).toEqual(["good sibling"]);
	});

	test("reports a malformed entry as errorCount but keeps valid siblings", () => {
		const out = parseRoomMessages(
			[
				{ message_id: "junk" }, // missing required fields -> malformed
				{ cursor: 5, author_id: "a1", body: "good" }, // valid
			],
			"r1",
		);
		expect(out.messages).toHaveLength(1);
		expect(out.errorCount).toBe(1);
		expect(out.messages[0]?.body).toBe("good");
	});

	test("non-array input returns empty with zero errors (no throw)", () => {
		expect(parseRoomMessages(null, "r1")).toEqual({ messages: [], errorCount: 0 });
		expect(parseRoomMessages(undefined, "r1")).toEqual({ messages: [], errorCount: 0 });
		expect(parseRoomMessages("not an array", "r1")).toEqual({ messages: [], errorCount: 0 });
	});

	test("all-null-author page is kept (no parse errors)", () => {
		// Huddora retains former-member/deleted-account messages with author_id null.
		const out = parseRoomMessages(
			[
				{ cursor: 1, author_id: null, body: "ghost A" },
				{ cursor: 2, author_id: null, body: "ghost B" },
			],
			"r1",
		);
		expect(out.errorCount).toBe(0);
		expect(out.messages).toHaveLength(2);
		expect(out.messages[0]?.author_id).toBeNull();
		expect(out.messages[0]?.body).toBe("ghost A");
		// author_name fallback must not slice null.
		expect(out.messages[0]?.author_name).toBe("unknown");
		// owner_id falls back to the (null) author_id safely.
		expect(out.messages[0]?.owner_id).toBeNull();
	});

	test("mixed null/normal author page keeps every row (no parse errors)", () => {
		const out = parseRoomMessages(
			[
				{ cursor: 1, author_id: null, body: "former member" },
				{ cursor: 2, author_id: "a1", author_name: "Alice", body: "current member" },
				{ cursor: 3, author_id: null, body: "another ghost" },
			],
			"r1",
		);
		expect(out.errorCount).toBe(0);
		expect(out.messages.map((m) => m.body)).toEqual([
			"former member",
			"current member",
			"another ghost",
		]);
		expect(out.messages[0]?.author_name).toBe("unknown");
		expect(out.messages[1]?.author_name).toBe("Alice");
	});

	test("a non-string non-null author_id is malformed (parse error)", () => {
		// author_id must be string or null; a number is structurally invalid.
		const out = parseRoomMessages(
			[
				{ cursor: 1, author_id: 123, body: "bad" },
				{ cursor: 2, author_id: "a1", body: "good" },
			],
			"r1",
		);
		expect(out.errorCount).toBe(1);
		expect(out.messages.map((m) => m.body)).toEqual(["good"]);
	});
});

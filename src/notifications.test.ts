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

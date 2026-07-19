import { describe, expect, test } from "bun:test";
import { HUDDORA_MESSAGES_METHOD, parseHuddoraMessagesNotification } from "./notifications";

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

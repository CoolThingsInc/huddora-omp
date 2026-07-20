import { describe, expect, test } from "bun:test";
import { buildMessageSendArgs, formatMessageSendToolResult } from "./send-tool";

describe("send-tool helpers", () => {
	test("buildMessageSendArgs mints client_message_id when omitted", () => {
		const args = buildMessageSendArgs(
			{
				room_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				body: "hello room",
			},
			() => "minted-id-123",
		);
		expect(args).toEqual({
			room_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			body: "hello room",
			client_message_id: "minted-id-123",
		});
	});

	test("buildMessageSendArgs keeps provided client_message_id and reply_to", () => {
		const args = buildMessageSendArgs({
			room_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			body: "reply body",
			client_message_id: "stable-key",
			reply_to: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		});
		expect(args.client_message_id).toBe("stable-key");
		expect(args.reply_to).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
	});

	test("buildMessageSendArgs truncates long client_message_id", () => {
		const long = "x".repeat(200);
		const args = buildMessageSendArgs({
			room_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			body: "x",
			client_message_id: long,
		});
		expect(args.client_message_id.length).toBe(128);
	});

	test("formatMessageSendToolResult success returns JSON text", () => {
		const out = formatMessageSendToolResult({
			ok: true,
			data: { message_id: "m1", body: "hi" },
		});
		expect(out.isError).toBeUndefined();
		expect(out.content[0]?.text).toContain("message_id");
		expect(out.content[0]?.text).toContain("m1");
	});

	test("formatMessageSendToolResult error sets isError", () => {
		const out = formatMessageSendToolResult({
			ok: false,
			message: "bridge unavailable",
		});
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toBe("bridge unavailable");
		expect(out.details).toEqual({ ok: false, error: "bridge unavailable" });
	});
});

describe("send tool presentation for xdev", () => {
	test("extension registers huddora_message_send as discoverable (xd:// mount)", async () => {
		const src = await Bun.file(new URL("./extension.ts", import.meta.url)).text();
		expect(src).toMatch(/name:\s*"huddora_message_send"/);
		expect(src).toMatch(/loadMode:\s*"discoverable"/);
		expect(src).not.toMatch(/name:\s*"huddora_message_send"[\s\S]{0,400}loadMode:\s*"essential"/);
		expect(src).toMatch(/xd:\/\/huddora_message_send/);
	});
});


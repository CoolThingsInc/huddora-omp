import { describe, expect, test, mock } from "bun:test";
import huddoraExtension from "./extension";
import * as commands from "./commands";
mock.module("./commands", () => ({
	...commands,
	deriveMenuActions: () => [
		{ id: "disconnect", label: "Disconnect", destructive: true, description: "Test" }
	],
	defaultMenuAction: () => "disconnect"
}));

describe("Extension UX wiring", () => {
	test("registers renderers and command with menu options on activation", async () => {
		const renderers = new Map<string, Function>();
		let huddoraCommand: any = null;
		const tools = new Map<string, any>();

		const piMock: any = {
			zod: { z: { object: mock().mockReturnValue({ describe: mock() }), string: mock().mockReturnValue({ describe: mock(), optional: mock().mockReturnValue({ describe: mock() }) }) } },
			setLabel: mock(),
			on: (evt: string, fn: any) => {
				if (evt === "session_branch") piMock._sessionBranch = fn;
			},
			appendEntry: mock(),
			registerMessageRenderer: (type: string, fn: Function) => {
				renderers.set(type, fn);
			},
			registerTool: (def: any) => {
				tools.set(def.name, def);
			},
			registerCommand: (name: string, def: any) => {
				if (name === "huddora") huddoraCommand = def;
			},
		};

		huddoraExtension(piMock);

		// Assert renderers registered
		expect(renderers.has("huddora-event")).toBe(true);
		expect(renderers.has("huddora-guidance")).toBe(true);
		expect(renderers.has("huddora-status")).toBe(true);

		// Assert command registered with derived description
		expect(huddoraCommand).toBeTruthy();
		expect(typeof huddoraCommand.description).toBe("string");
		expect(huddoraCommand.description).toContain("Huddora: init|config|room");

		// Assert tool registered with correct semantics + renderers
		const toolDef = tools.get("huddora_message_send");
		expect(toolDef).toBeTruthy();
		expect(typeof toolDef.renderCall).toBe("function");
		expect(typeof toolDef.renderResult).toBe("function");
		for (const name of [
			"huddora_task_list",
			"huddora_task_accept",
			"huddora_task_handoff",
			"huddora_task_complete",
			"huddora_task_fail",
		]) {
			expect(tools.get(name)?.loadMode).toBe("discoverable");
			expect(tools.get(name)?.approval).toBe("write");
		}

		const fakeTheme = {
			fg: (c: string, t: string) => `[${c}]${t}[/${c}]`,
			bold: (t: string) => `*${t}*`,
		};

		// Test tool execute fast-fail validates UUID and length, returning proper content schema without crashing
		const badRoomRes = await toolDef.execute("call1", { room_id: "not-a-uuid", body: "Hello" }, undefined, undefined, undefined);
		expect(badRoomRes.isError).toBe(true);
		expect(badRoomRes.content[0].text).toContain("room_id must be a UUID");

		// Test tool renderCall
		const callText = toolDef.renderCall({ room_id: "12345678-abcd-abcd-abcd-1234567890ab", body: "Hello World" }, { expanded: false }, fakeTheme);
		expect(callText.getText()).toBe("[toolTitle]*Huddora · Send message*[/toolTitle][muted] · room 12345678 · 11 chars[/muted]");

		// Test tool renderResult (success)
		const okResText = toolDef.renderResult({ isError: false, details: { ok: true } }, { expanded: false }, fakeTheme);
		expect(okResText.getText()).toBe("[success]*Huddora · Message sent*[/success]");

		// Test tool renderResult (error parsing truncates payload dumps)
		const errResText = toolDef.renderResult(
			{
				isError: true,
				content: [{ type: "text", text: "Something went wrong\nVery long secret payload stack trace that should be omitted" }],
				details: { ok: false },
			},
			{ expanded: false },
			fakeTheme
		);
		expect(errResText.getText()).toBe("[error]*Huddora · Message not sent* · Something went wrong[/error]");

		// Test no-arg menu invocation and disconnect confirmation
		let selectCalledWith: any = null;
		let confirmCalledWith: any = null;
		let widgetCleared = false;
		let statusCleared = false;

		const ctxMock: any = {
			hasUI: true,
			cwd: process.cwd(),
			setTimeout: () => 1,
			setInterval: () => 1,
			clearTimer: () => {},
			sessionManager: {
				getBranch: () => [{ type: "custom", customType: "huddora-state", data: { roomId: "fake-room-id" } }],
			},
			ui: {
				select: async (title: string, options: any, opts: any) => {
					selectCalledWith = { title, options, opts };
					return "Disconnect"; // Pick destructive action
				},
				confirm: async (title: string, message: string) => {
					confirmCalledWith = { title, message };
					return true; // Confirm disconnect
				},
				setWidget: (key: string, val: any) => {
					if (key === "huddora" && val === undefined) widgetCleared = true;
				},
				setStatus: (key: string, val: any) => {
					if (key === "huddora" && val === undefined) statusCleared = true;
				},
				notify: mock(),
			},
		};
		// Provide an initial session/room to trigger the "Disconnect" option
		// The `session_branch` handler reads the mock branch above and restores the `roomId: "fake-room-id"`.
		await piMock._sessionBranch(null, ctxMock);
		// The select mock returns "Disconnect", which maps to "disconnect".
		await huddoraCommand.handler("", ctxMock);

		expect(selectCalledWith).toBeTruthy();
		expect(selectCalledWith.title).toBe("Huddora");
		// Verify help text
		expect(selectCalledWith.opts.helpText).toBe("Enter to run · Esc to close");

		// Verify disconnect confirmation
		expect(confirmCalledWith).toBeTruthy();
		expect(confirmCalledWith.title).toBe("Disconnect Huddora?");

		// Verify the disconnect handler cleans up widget/status
		expect(widgetCleared).toBe(true);
		expect(statusCleared).toBe(true);

		// Verify human copy forbidden-jargon sweep on the notify (should just say "Huddora: disconnected. ...")
		const notifyCalls = ctxMock.ui.notify.mock.calls;
		const disconnectCall = notifyCalls.find((args: string[]) => args[0]?.includes("disconnected"));
		expect(disconnectCall).toBeTruthy();
		expect(disconnectCall[0]).not.toMatch(/bridge|SSE|poll|courier|seat_stamp|MCPManager/i);
	});
	test("RPC-like setWidget factory drop keeps compact status populated", async () => {
		// Simulate RPC mode: setWidget silently drops component-factory content
		// (no throw, no render) — only string[]/undefined are honored.
		let branchHandler: any = null;
		const widgetCalls: Array<{ key: string; content: any }> = [];
		const statusCalls: Array<{ key: string; text: any }> = [];

		const piMock: any = {
			zod: { z: { object: mock().mockReturnValue({ describe: mock() }), string: mock().mockReturnValue({ describe: mock(), optional: mock().mockReturnValue({ describe: mock() }) }) } },
			setLabel: mock(),
			on: (evt: string, fn: any) => {
				if (evt === "session_branch") branchHandler = fn;
			},
			appendEntry: mock(),
			registerMessageRenderer: () => {},
			registerTool: () => {},
			registerCommand: () => {},
		};

		huddoraExtension(piMock);

		const ctxMock: any = {
			hasUI: true,
			cwd: process.cwd(),
			setTimeout: () => 1,
			setInterval: () => 1,
			clearTimer: () => {},
			sessionManager: { getBranch: () => [] },
			ui: {
				// RPC-like: only string[]/undefined are honored; factory content is silently dropped (no throw).
				setWidget: (key: string, content: any) => {
					widgetCalls.push({ key, content });
					// RPC mode only emits string[]/undefined to the client; factories are dropped.
				},
				setStatus: (key: string, text: any) => statusCalls.push({ key, text }),
				notify: mock(),
				theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
			},
		};

		await branchHandler(null, ctxMock);

		// The factory widget is still attempted (interactive primary surface) even though RPC drops it.
		const factoryWidget = widgetCalls.find((w: { key: string; content: any }) => w.key === "huddora" && typeof w.content === "function");
		expect(factoryWidget).toBeTruthy();

		// Compact footer line must be populated even though the factory widget was dropped.
		const compactStatus = statusCalls.find((s: { key: string; text: any }) => s.key === "huddora" && typeof s.text === "string" && s.text.length > 0);
		expect(compactStatus).toBeTruthy();

		// The footer must never be cleared during refresh (no setStatus(key, undefined) on the huddora key).
		const clearedStatus = statusCalls.find((s: { key: string; text: any }) => s.key === "huddora" && s.text === undefined);
		expect(clearedStatus).toBeUndefined();
	});
});

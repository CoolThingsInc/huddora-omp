import { beforeEach, describe, expect, test } from "bun:test";
import {
	__setHostMcpForTests,
	callHuddoraTool,
	formatHybridPullHint,
	getHuddoraConnectionStatus,
	getHostMcpManager,
	resolveHostMcp,
	setPluginBridge,
} from "./mcp-client";

describe("bridge tool path + optional host manager", () => {
	beforeEach(() => {
		__setHostMcpForTests(null);
		setPluginBridge(null);
	});

	test("without bridge, tools fail with bridge-not-started", async () => {
		expect(await getHuddoraConnectionStatus()).toBe("bridge_missing");
		// In unit tests MCPManager.instance() is typically null.
		const mgr = await getHostMcpManager();
		const host = await resolveHostMcp();
		if (mgr) {
			expect(host.mode).toBe("manager");
		} else {
			expect(host).toEqual({
				mode: "unavailable",
				detail: "MCPManager.instance() null — host seat bind best-effort",
			});
		}
		const before = await callHuddoraTool("room_list");
		expect(before).toEqual({
			ok: false,
			error: { kind: "no_host_api", message: "Plugin MCP session not started." },
		});
	});

	test("installed bridge is the tool path for plugin calls", async () => {
		let bridgeCalls = 0;
		setPluginBridge(async (toolName, args) => {
			bridgeCalls++;
			expect(toolName).toBe("room_list");
			expect(args).toEqual({});
			return { ok: true, data: { rooms: [{ room_id: "r1", name: "Ops" }] } };
		});

		expect(await getHuddoraConnectionStatus()).toBe("bridge");
		expect(await callHuddoraTool("room_list")).toEqual({
			ok: true,
			data: { rooms: [{ room_id: "r1", name: "Ops" }] },
		});
		expect(bridgeCalls).toBe(1);
	});

	test("clearing bridge returns missing status", async () => {
		setPluginBridge(async () => ({ ok: true, data: {} }));
		expect(await getHuddoraConnectionStatus()).toBe("bridge");
		setPluginBridge(null);
		expect(await getHuddoraConnectionStatus()).toBe("bridge_missing");
		expect((await callHuddoraTool("agent_register")).ok).toBe(false);
	});
});

describe("formatHybridPullHint", () => {
	test("no dead /huddora bridge command and stays actionable", () => {
		const hint = formatHybridPullHint({
			roomId: "r1",
			roomName: "Ops",
			cursor: 42,
			limit: 10,
		});

		// Dead command reference must not appear anywhere in the hint.
		expect(hint).not.toContain("/huddora bridge");

		// Plugin connection is unavailable; recovery is reauth then connect.
		expect(hint).toContain("plugin connection is unavailable");
		expect(hint).toContain("/mcp reauth huddora");
		expect(hint).toContain("/huddora connect");

		// Fallback stays actionable with the technical fields the model needs.
		expect(hint).toContain("message_history");
		expect(hint).toContain("room_id=r1");
		expect(hint).toContain("room_name=Ops");
		expect(hint).toContain("after_cursor=42");
		expect(hint).toContain("limit=10");
	});

	test("falls back to room id when name is missing", () => {
		const hint = formatHybridPullHint({
			roomId: "r1",
			roomName: null,
			cursor: 0,
			limit: 1,
		});
		expect(hint).toContain("room_name=r1");
		expect(hint).toContain("after_cursor=0");
		expect(hint).toContain("limit=1");
		expect(hint).not.toContain("/huddora bridge");
	});
});

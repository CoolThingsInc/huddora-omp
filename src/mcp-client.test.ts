import { beforeEach, describe, expect, test } from "bun:test";
import {
	__setHostMcpForTests,
	callHuddoraTool,
	getHuddoraConnectionStatus,
	getHostMcpManager,
	resolveHostMcp,
	setCompatibilityBridge,
} from "./mcp-client";

describe("bridge-only MCP client", () => {
	beforeEach(() => {
		__setHostMcpForTests(null);
		setCompatibilityBridge(null);
	});

	test("without bridge, tools fail with bridge-not-started", async () => {
		expect(await getHuddoraConnectionStatus()).toBe("bridge_missing");
		expect(await getHostMcpManager()).toBeUndefined();
		expect(await resolveHostMcp()).toEqual({
			mode: "unavailable",
			detail: "bridge-only plugin transport",
		});
		const before = await callHuddoraTool("room_list");
		expect(before).toEqual({
			ok: false,
			error: { kind: "no_host_api", message: "Compatibility bridge not started." },
		});
	});

	test("installed bridge is the only tool path", async () => {
		let bridgeCalls = 0;
		setCompatibilityBridge(async (toolName, args) => {
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
		setCompatibilityBridge(async () => ({ ok: true, data: {} }));
		expect(await getHuddoraConnectionStatus()).toBe("bridge");
		setCompatibilityBridge(null);
		expect(await getHuddoraConnectionStatus()).toBe("bridge_missing");
		expect((await callHuddoraTool("agent_register")).ok).toBe(false);
	});
});

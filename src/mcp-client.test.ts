import { beforeEach, describe, expect, test } from "bun:test";
import {
	__setHostMcpForTests,
	callHuddoraTool,
	getHuddoraConnectionStatus,
	setCompatibilityBridge,
} from "./mcp-client";

type FakeManager = {
	getConnectionStatus(name: string): "connected";
	getConnection(name: string): { name: string } | undefined;
	waitForConnection(name: string): Promise<{ name: string }>;
	getAllServerNames(): string[];
};

describe("host MCP lifecycle", () => {
	beforeEach(() => {
		__setHostMcpForTests(null);
		setCompatibilityBridge(null);
	});

	test("connect recovers when the host manager appears after plugin initialization", async () => {
		let manager: FakeManager | undefined;
		const connection = { name: "huddora" };
		const managerClass = {
			instance: () => manager,
		};
		const callTool = async (received: unknown, toolName: string) => {
			expect(received).toBe(connection);
			expect(toolName).toBe("room_list");
			return { content: [{ type: "text", text: '{"rooms":[]}' }] };
		};
		__setHostMcpForTests({ mode: "host_manager", manager: managerClass, callTool });

		expect(await getHuddoraConnectionStatus()).toBe("no_manager");
		const before = await callHuddoraTool("room_list");
		expect(before).toEqual({
			ok: false,
			error: { kind: "disconnected", message: "MCP manager not installed on this session yet" },
		});

		manager = {
			getConnectionStatus: () => "connected",
			getConnection: () => connection,
			waitForConnection: async () => connection,
			getAllServerNames: () => ["huddora"],
		};

		expect(await getHuddoraConnectionStatus()).toBe("connected");
		expect(await callHuddoraTool("room_list")).toEqual({ ok: true, data: { rooms: [] } });
	});

	test("uses the host API before an installed compatibility bridge", async () => {
		const connection = { name: "huddora" };
		let bridgeCalls = 0;
		const manager = {
			instance: () => ({
				getConnectionStatus: () => "connected" as const,
				getConnection: () => connection,
				waitForConnection: async () => connection,
				getAllServerNames: () => ["huddora"],
			}),
		};
		__setHostMcpForTests({
			mode: "host_manager",
			manager,
			callTool: async () => ({ content: [{ type: "text", text: "{}" }] }),
		});
		setCompatibilityBridge(async () => {
			bridgeCalls++;
			return { ok: true, data: { source: "bridge" } };
		});

		expect(await callHuddoraTool("room_list")).toEqual({ ok: true, data: {} });
		expect(bridgeCalls).toBe(0);
	});
});

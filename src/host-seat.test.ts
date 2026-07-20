import { describe, expect, test } from "bun:test";
import { bindHostAgentSeat, parseHostToolResult } from "./host-seat";

describe("parseHostToolResult", () => {
	test("success payload", () => {
		expect(parseHostToolResult({ content: [{ type: "text", text: '{"agent_id":"a"}' }] })).toEqual({
			ok: true,
			isError: false,
			message: '{"agent_id":"a"}',
		});
	});

	test("isError true", () => {
		const r = parseHostToolResult({
			isError: true,
			content: [{ type: "text", text: "agent_not_bound" }],
		});
		expect(r.ok).toBe(false);
		expect(r.isError).toBe(true);
		expect(r.message).toBe("agent_not_bound");
	});

	test("null empty", () => {
		expect(parseHostToolResult(null).ok).toBe(false);
	});
});

describe("bindHostAgentSeat", () => {
	test("returns detail when MCPManager.instance is null", async () => {
		const out = await bindHostAgentSeat(
			{ session_key: "seat", extension_version: "0.3.21", harness: "omp", delivery_mode: "mcp_push" },
			{
				loadMcp: async () => ({
					MCPManager: { instance: () => undefined },
					callTool: async () => {
						throw new Error("should not call");
					},
				}),
			},
		);
		expect(out.ok).toBe(false);
		expect(out.detail).toMatch(/MCPManager\.instance\(\) null/);
		expect(out.detail).toMatch(/dual-package/);
	});

	test("calls agent_register on host connection with same args", async () => {
		const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
		const conn = { id: "host-conn" };
		const args = {
			session_key: "seat-a",
			extension_version: "0.3.21",
			harness: "omp",
			delivery_mode: "mcp_push",
		};
		const out = await bindHostAgentSeat(args, {
			loadMcp: async () => ({
				MCPManager: {
					instance: () => ({
						getConnection: (name: string) => (name === "huddora" ? conn : undefined),
						waitForConnection: async () => conn,
					}),
				},
				callTool: async (_c, tool, a) => {
					calls.push({ tool, args: a });
					return { content: [{ type: "text", text: '{"agent_id":"x"}' }] };
				},
			}),
		});
		expect(out.ok).toBe(true);
		expect(out.detail).toMatch(/ok/);
		expect(calls).toEqual([{ tool: "agent_register", args }]);
	});

	test("waitForConnection timeout soft-fails with detail", async () => {
		const out = await bindHostAgentSeat(
			{ session_key: "seat" },
			{
				timeoutMs: 20,
				loadMcp: async () => ({
					MCPManager: {
						instance: () => ({
							getConnection: () => undefined,
							waitForConnection: () => new Promise(() => {}),
						}),
					},
					callTool: async () => ({ content: [] }),
				}),
			},
		);
		expect(out.ok).toBe(false);
		expect(out.detail).toMatch(/not ready/);
	});
});

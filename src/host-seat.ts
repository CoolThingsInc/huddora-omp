/**
 * Host MCP seat bind — co-claim the same session_key on the host huddora connection
 * so model tools (mcp__huddora_message_send) share identity with the bridge.
 *
 * Best-effort: plugin dynamic import of @oh-my-pi/pi-coding-agent/mcp often resolves to a
 * different module instance than the bundled omp binary (dual-package). Then
 * MCPManager.instance() is null even though host tools work — host bind soft-fails and
 * the plugin falls back to single-outbound (hide host mute-trap tools).
 */

export type HostRegisterResult = {
	ok: boolean;
	isError: boolean;
	message: string | null;
};

/** Parse host callTool / MCP tools/call result for isError. */
export function parseHostToolResult(result: unknown): HostRegisterResult {
	if (result == null || typeof result !== "object") {
		return { ok: false, isError: true, message: "host_tool_empty" };
	}
	const r = result as { isError?: unknown; content?: unknown };
	const isError = r.isError === true;
	let message: string | null = null;
	if (Array.isArray(r.content)) {
		for (const part of r.content) {
			if (part && typeof part === "object" && Reflect.get(part, "type") === "text") {
				const text = Reflect.get(part, "text");
				if (typeof text === "string" && text.trim()) {
					message = text;
					break;
				}
			}
		}
	}
	if (isError) {
		return { ok: false, isError: true, message: message ?? "host_tool_error" };
	}
	return { ok: true, isError: false, message };
}

export type HostMcpManagerLike = {
	getConnection: (name: string) => unknown | undefined;
	waitForConnection: (name: string) => Promise<unknown>;
};

type HostMcpModule = {
	MCPManager: { instance: () => HostMcpManagerLike | undefined };
	// connection is MCPServerConnection at runtime; keep loose for test doubles.
	callTool: (connection: never, toolName: string, args: Record<string, unknown>) => Promise<unknown>;
};

export type HostSeatDeps = {
	/** Dynamic import of @oh-my-pi/pi-coding-agent/mcp (or test double). */
	loadMcp?: () => Promise<HostMcpModule>;
	/** Wait for connection timeout ms. */
	timeoutMs?: number;
};

export type HostBindOutcome = {
	ok: boolean;
	/** Short reason for doctor / residual honesty. */
	detail: string;
};

/**
 * Bind host MCP "huddora" connection with the same agent_register args as the bridge.
 * Returns ok + diagnostic detail (never throws).
 */
export async function bindHostAgentSeat(
	args: Record<string, unknown>,
	deps: HostSeatDeps = {},
): Promise<HostBindOutcome> {
	const timeoutMs = deps.timeoutMs ?? 3_000;
	try {
		const load =
			deps.loadMcp ??
			(async () => {
				const mod = await import("@oh-my-pi/pi-coding-agent/mcp");
				return {
					MCPManager: mod.MCPManager,
					callTool: mod.callTool as HostMcpModule["callTool"],
				};
			});
		const { MCPManager, callTool } = await load();
		const manager = MCPManager.instance();
		if (!manager) {
			// Dual-package: plugin node_modules MCPManager ≠ bundled omp singleton.
			return {
				ok: false,
				detail: "MCPManager.instance() null (plugin import ≠ host singleton / dual-package)",
			};
		}

		let conn = manager.getConnection("huddora");
		if (!conn) {
			conn = await Promise.race([
				manager.waitForConnection("huddora"),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
			]);
		}
		if (!conn) {
			return { ok: false, detail: `huddora host connection not ready within ${timeoutMs}ms` };
		}

		const result = await callTool(conn as never, "agent_register", args);
		const parsed = parseHostToolResult(result);
		if (!parsed.ok) {
			return {
				ok: false,
				detail: `host agent_register failed: ${(parsed.message ?? "error").slice(0, 200)}`,
			};
		}
		return { ok: true, detail: "host agent_register ok" };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, detail: `host bind exception: ${msg.slice(0, 200)}` };
	}
}

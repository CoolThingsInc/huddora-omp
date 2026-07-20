/**
 * Host MCP seat bind — co-claim the same session_key on the host huddora connection
 * so model tools (mcp__huddora_message_send) share identity with the bridge.
 *
 * Best-effort: MCPManager.instance() may be null in the extension process.
 * Bridge remains authoritative for presence/watch when host bind fails.
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

/**
 * Bind host MCP "huddora" connection with the same agent_register args as the bridge.
 * Returns whether host seat was successfully bound.
 */
export async function bindHostAgentSeat(
	args: Record<string, unknown>,
	deps: HostSeatDeps = {},
): Promise<boolean> {
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
		if (!manager) return false;

		let conn = manager.getConnection("huddora");
		if (!conn) {
			conn = await Promise.race([
				manager.waitForConnection("huddora"),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
			]);
		}
		if (!conn) return false;

		const result = await callTool(conn as never, "agent_register", args);
		const parsed = parseHostToolResult(result);
		return parsed.ok;
	} catch {
		return false;
	}
}

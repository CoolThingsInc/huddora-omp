/**
 * Pure helpers for the plugin-bound huddora_message_send tool.
 * Model-facing send uses the plugin bridge session (bound seat).
 * On OMP with tools.xdev, the tool is loadMode "discoverable" so it mounts as
 * xd://huddora_message_send (write JSON args). Essential would hide it from xd inventory.
 * Host mcp__huddora_message_send is only co-owned when host seat bind succeeds;
 * otherwise it is a mute-online trap and is hidden from the model surface.
 */

export type MessageSendParams = {
	room_id: string;
	body: string;
	client_message_id?: string;
	reply_to?: string;
};

export type BridgeCallResult =
	| { ok: true; data: unknown }
	| { ok: false; message: string };

/** Build MCP message_send args; mint client_message_id when omitted. */
export function buildMessageSendArgs(
	params: MessageSendParams,
	idFactory: () => string = () => crypto.randomUUID(),
): {
	room_id: string;
	body: string;
	client_message_id: string;
	reply_to?: string;
} {
	const client_message_id =
		typeof params.client_message_id === "string" && params.client_message_id.length > 0
			? params.client_message_id.slice(0, 128)
			: idFactory().slice(0, 128);
	const args: {
		room_id: string;
		body: string;
		client_message_id: string;
		reply_to?: string;
	} = {
		room_id: params.room_id,
		body: params.body,
		client_message_id,
	};
	if (typeof params.reply_to === "string" && params.reply_to.length > 0) {
		args.reply_to = params.reply_to;
	}
	return args;
}

/** Format bridge result for the model tool surface. */
export function formatMessageSendToolResult(result: BridgeCallResult): {
	content: Array<{ type: "text"; text: string }>;
	isError?: true;
	details: Record<string, unknown>;
} {
	if (result.ok) {
		const text =
			typeof result.data === "string"
				? result.data
				: JSON.stringify(result.data ?? {}, null, 0);
		return {
			content: [{ type: "text", text }],
			details: { ok: true },
		};
	}
	return {
		content: [{ type: "text", text: result.message }],
		isError: true,
		details: { ok: false, error: result.message },
	};
}

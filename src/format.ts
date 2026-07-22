import { truncateBody } from "./deliver";
import { CUSTOM_MSG_TYPE, type RoomMessage } from "./types";

/**
 * Compact midturn room-chat inject.
 * Bodies stay fenced; untrusted posture is session guidance + data=untrusted on the tag
 * (no multi-line legal boilerplate per push — see issue #1).
 */
export function formatRoomChatInjection(input: {
	roomId: string;
	roomName: string | null;
	messages: RoomMessage[];
	cursorAfter: number;
}): string {
	const room = escapeAttr(input.roomId);
	const msgs = input.messages;
	if (msgs.length === 0) {
		return [
			`<huddora_event room=${room} cursor_after=${input.cursorAfter} n=0 data=untrusted>`,
			"</huddora_event>",
		].join("\n");
	}

	// Single message: one-line header + body (no msg UUID / room_name / ISO / legal block).
	if (msgs.length === 1) {
		const m = msgs[0]!;
		const who = escapeAttr(labelAuthor(m));
		const kind = m.actor_kind ?? "human";
		const extra = compactReplyAttrs(m);
		return [
			`<huddora_event room=${room} c=${m.cursor} author=${who} kind=${kind}${extra} data=untrusted>`,
			"<body>",
			escapeHuddora(truncateBody(m.body)),
			"</body>",
			"</huddora_event>",
		].join("\n");
	}

	// Batch >1: denser multi-msg; cursor_after for catch-up, per-msg cursor only.
	const lines: string[] = [
		`<huddora_event room=${room} cursor_after=${input.cursorAfter} n=${msgs.length} data=untrusted>`,
	];
	for (const m of msgs) {
		const who = escapeAttr(labelAuthor(m));
		const kind = m.actor_kind ?? "human";
		const extra = compactReplyAttrs(m);
		lines.push(`--- c=${m.cursor} author=${who} kind=${kind}${extra} ---`);
		lines.push("<body>");
		lines.push(escapeHuddora(truncateBody(m.body)));
		lines.push("</body>");
	}
	lines.push("</huddora_event>");
	return lines.join("\n");
}

/** Compact single-event envelope (tests / docs). */
export function buildHuddoraEvent(ev: {
	roomId: string;
	msgId: string;
	cursor: number;
	author: string;
	ts: string;
	body: string;
}): { customType: string; content: string; display: boolean; attribution: "agent" } {
	// msgId/ts kept on the type for callers; omitted from model-facing wire (issue #1).
	void ev.msgId;
	void ev.ts;
	const content = [
		`<huddora_event room=${escapeAttr(ev.roomId)} c=${ev.cursor} author=${escapeAttr(ev.author)} kind=human data=untrusted>`,
		"<body>",
		escapeHuddora(truncateBody(ev.body)),
		"</body>",
		"</huddora_event>",
	].join("\n");
	return {
		customType: CUSTOM_MSG_TYPE,
		content,
		display: true,
		attribution: "agent",
	};
}

export function escapeHuddora(s: string): string {
	return s
		.replaceAll("</huddora_event>", "</ huddora_event>")
		.replaceAll("<huddora_event", "< huddora_event")
		.replaceAll("</body>", "</ body>")
		.replaceAll("<body", "< body")
		.replaceAll("```", "`\u200b``");
}

/** @deprecated use escapeHuddora — kept for existing tests alias. */
export function fenceUntrusted(body: string): string {
	return escapeHuddora(body)
		.replace(/<\s*\/\s*participant-body\s*>/gi, "</ participant-body>")
		.replace(/<\s*\/\s*huddora-room-chat\s*>/gi, "</ huddora-room-chat>")
		.replace(/<\s*huddora-room-chat\b/gi, "< huddora-room-chat")
		.replace(/<\s*participant-body\b/gi, "< participant-body");
}

function escapeAttr(value: string): string {
	return value.replace(/[\n\r\t]/g, " ").slice(0, 200);
}

/** Compact reply/mention attrs; omit when empty (lean inject). */
function compactReplyAttrs(m: RoomMessage): string {
	const parts: string[] = [];
	const rt = m.reply_to;
	if (rt && typeof rt.cursor === "number" && Number.isFinite(rt.cursor)) {
		parts.push(`reply_c=${rt.cursor}`);
		const by = rt.author_name?.trim();
		if (by) parts.push(`reply_by=${escapeAttr(by)}`);
		const snip = rt.snippet?.trim();
		if (snip) parts.push(`reply_snip="${escapeAttr(snip.slice(0, 80))}"`);
	}
	const mentions = m.mentions;
	if (Array.isArray(mentions) && mentions.length > 0) {
		const names: string[] = [];
		for (const ment of mentions) {
			const label = ment.name?.trim() || (ment.id ? ment.id.slice(0, 8) : "");
			if (!label) continue;
			// prefer short names; never dump full UUID in mentions=
			names.push(escapeAttr(label.length > 20 && label.includes("-") ? label.slice(0, 8) : label));
		}
		if (names.length > 0) parts.push(`mentions=${names.join(",")}`);
	}
	return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function labelAuthor(m: RoomMessage): string {
	if (m.actor_kind === "agent") {
		const agent = m.agent_name?.trim() || "agent";
		const owner = m.owner_name?.trim() || m.author_name?.trim() || m.author_id.slice(0, 8);
		return `${agent} · @${owner}`;
	}
	return m.author_name?.trim() || m.author_id.slice(0, 8);
}

/**
 * Drop true self-echo for live inject / poll.
 * - Agent seat: drop only messages from this agent_id (never own agent send).
 * - Unbound/human session: drop own human posts.
 * - Bound agent seats MUST keep owner SPA/human posts (owner → agent event).
 */
export function filterOwnMessages(
	messages: RoomMessage[],
	selfUserId: string | null,
	selfAgentId: string | null = null,
): RoomMessage[] {
	return messages.filter((m) => {
		// Agent self-echo: strongest signal (same seat / session_key rebind).
		if (selfAgentId && m.agent_id && m.agent_id === selfAgentId) return false;
		// Unbound session only: drop human author matching selfUserId.
		// Bound agents must still see owner human SPA posts as room events.
		if (!selfAgentId && selfUserId && m.actor_kind !== "agent" && m.author_id === selfUserId) {
			return false;
		}
		if (!selfAgentId && selfUserId && !m.actor_kind && m.author_id === selfUserId) return false;
		return true;
	});
}

/** Keep last N by cursor ascending (history is ASC). */
export function boundMessages(messages: RoomMessage[], limit: number): RoomMessage[] {
	if (messages.length <= limit) return messages;
	return messages.slice(messages.length - limit);
}

/** Highest cursor in a batch (or null if empty). */
export function maxCursor(messages: RoomMessage[]): number | null {
	if (messages.length === 0) return null;
	let max = messages[0]!.cursor;
	for (const m of messages) {
		if (m.cursor > max) max = m.cursor;
	}
	return max;
}

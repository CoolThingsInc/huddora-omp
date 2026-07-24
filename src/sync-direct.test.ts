/**
 * Sync-level integration of direct-response classification.
 *
 * pullAndFormat pulls via mcp-message_history, classifies the batch with
 * isDirectBatch(messages, selfAgentId), and carries triggerEligible through the
 * injected SyncOutcome so delivery gating (gateInject) can decide wake vs
 * context-only. These tests stub the plugin bridge and assert the contract:
 *   - direct batch (mention of self OR reply-to-self)      => triggerEligible true
 *   - ambient agent-only / ambient human batch               => triggerEligible false
 *   - mixed batch with any direct message                    => triggerEligible true
 *   - reply_to missing parent identity fails the page (clean cutover) — parse_error, no cursor advance
 *   - no_room / empty / error outcomes have no triggerEligible
 *   - injected content still contains ALL messages (visibility never filtered)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setPluginBridge } from "./mcp-client";
import { pullAndFormat, type SyncOutcome } from "./sync";
import { defaultState, type HuddoraPluginState, type RoomMessage } from "./types";

const SELF = "agent-self-id";
const OTHER_AGENT = "agent-other-id";
const ROOM = "room-1";

function baseState(cursor = 0): HuddoraPluginState {
	return {
		...defaultState(),
		roomId: ROOM,
		roomName: "Ops",
		cursor,
		selfUserId: "user-self",
		selfAgentId: SELF,
	};
}

/** Minimal history message shape the server returns (enriched reply_to + mentions). */
function msg(partial: Partial<RoomMessage> & Pick<RoomMessage, "cursor" | "body">): RoomMessage {
	const cursor = partial.cursor;
	const author_id = partial.author_id ?? "user-peer";
	return {
		message_id: partial.message_id ?? `m-${cursor}`,
		room_id: ROOM,
		cursor,
		author_id,
		author_name: partial.author_name ?? "Peer",
		body: partial.body,
		client_message_id: partial.client_message_id ?? `c-${cursor}`,
		created_at: partial.created_at ?? "2026-01-01T00:00:00Z",
		actor_kind: partial.actor_kind,
		agent_id: partial.agent_id,
		agent_name: partial.agent_name,
		owner_id: partial.owner_id,
		owner_name: partial.owner_name,
		reply_to: partial.reply_to,
		mentions: partial.mentions,
	};
}

/** Install a bridge returning the given messages for message_history. */
function stubHistory(messages: RoomMessage[], nextCursor: number | null): void {
	setPluginBridge(async (toolName, _args) => {
		if (toolName !== "message_history") {
			return { ok: false, error: { kind: "tool_error", message: `unexpected ${toolName}` } };
		}
		return { ok: true, data: { messages, next_cursor: nextCursor } };
	});
}

/**
 * Install a bridge returning RAW (untyped) message bodies for message_history.
 * Exercises the durable sanitization path: mcpMessageHistory now runs every
 * message through parseRoomMessages before classification, so malformed
 * mentions/reply identity cannot masquerade as a structured self-mention.
 */
function stubRawHistory(rawMessages: unknown[], nextCursor: number | null): void {
	setPluginBridge(async (toolName, _args) => {
		if (toolName !== "message_history") {
			return { ok: false, error: { kind: "tool_error", message: `unexpected ${toolName}` } };
		}
		return { ok: true, data: { messages: rawMessages, next_cursor: nextCursor } };
	});
}

/** Minimal raw message shape omitting validation-incompatible defaults. */
function rawMsg(fields: Record<string, unknown>): Record<string, unknown> {
	return {
		message_id: "m-raw",
		room_id: ROOM,
		cursor: 1,
		author_id: "user-peer",
		author_name: "Peer",
		body: "raw body",
		client_message_id: "c-raw",
		created_at: "2026-01-01T00:00:00Z",
		actor_kind: "agent",
		agent_id: OTHER_AGENT,
		...fields,
	};
}

/** Narrow a SyncOutcome to its { kind: "injected" } variant, asserting the kind. */
function injected(r: SyncOutcome): Extract<SyncOutcome, { kind: "injected" }> {
	expect(r.kind).toBe("injected");
	if (r.kind === "injected") return r;
	throw new Error("unreachable: not injected");
}

/** triggerEligible only exists on the injected variant; assert its absence otherwise. */
function assertNoTriggerFlag(r: SyncOutcome): void {
	expect(r.kind).not.toBe("injected");
	if ("triggerEligible" in r) throw new Error("non-injected outcome must not carry triggerEligible");
}

beforeEach(() => setPluginBridge(null));
afterEach(() => setPluginBridge(null));

describe("pullAndFormat triggerEligible — direct mention of self", () => {
	test("agent @mention of self => triggerEligible true, content injected", async () => {
		const batch = [
			msg({
				cursor: 1,
				body: "hey @self do X",
				actor_kind: "agent",
				agent_id: OTHER_AGENT,
				mentions: [{ kind: "agent", id: SELF, name: "me" }],
			}),
		];
		stubHistory(batch, 1);
		const r = injected(await pullAndFormat(baseState(0)));
		expect(r.messageCount).toBe(1);
		expect(r.triggerEligible).toBe(true);
		// Visibility never filtered: the body is present in inject context.
		expect(r.content).toContain("hey @self do X");
		expect(r.cursorAfter).toBe(1);
	});
});

describe("pullAndFormat triggerEligible — reply-to-self agent", () => {
	test("reply whose parent was authored by this seat => triggerEligible true", async () => {
		const batch = [
			msg({
				cursor: 2,
				body: "following up on your earlier note",
				actor_kind: "agent",
				agent_id: OTHER_AGENT,
				reply_to: {
					message_id: "m-1",
					cursor: 1,
					author_name: "me",
					snippet: "earlier",
					actor_kind: "agent",
					agent_id: SELF,
				},
			}),
		];
		stubHistory(batch, 2);
		const r = injected(await pullAndFormat(baseState(0)));
		expect(r.triggerEligible).toBe(true);
		expect(r.content).toContain("following up on your earlier note");
	});
});

describe("pullAndFormat triggerEligible — reply-to-other", () => {
	test("reply whose parent was authored by a different agent => ambient (triggerEligible false)", async () => {
		const THIRD = "agent-third-id";
		const batch = [
			msg({
				cursor: 3,
				body: "replying to other, not you",
				actor_kind: "agent",
				agent_id: OTHER_AGENT,
				reply_to: {
					message_id: "m-2",
					cursor: 2,
					author_name: "other",
					snippet: "o",
					actor_kind: "agent",
					agent_id: THIRD,
				},
			}),
		];
		stubHistory(batch, 3);
		const r = injected(await pullAndFormat(baseState(0)));
		// Reply parent authored by another agent does not address THIS seat.
		expect(r.triggerEligible).toBe(false);
		// Still injected as room context.
		expect(r.content).toContain("replying to other, not you");
	});
});

describe("pullAndFormat triggerEligible — ambient agent and human", () => {
	test("agent-authored ambient (mentions another agent, no self) => not trigger-eligible", async () => {
		const batch = [
			msg({
				cursor: 4,
				body: "ambient agent chatter",
				actor_kind: "agent",
				agent_id: OTHER_AGENT,
				mentions: [{ kind: "agent", id: OTHER_AGENT, name: "other" }],
			}),
		];
		stubHistory(batch, 4);
		const r = injected(await pullAndFormat(baseState(0)));
		expect(r.triggerEligible).toBe(false);
		expect(r.content).toContain("ambient agent chatter");
	});
	test("human ambient (no mention/reply targeting self) => not trigger-eligible", async () => {
		const batch = [
			msg({
				cursor: 5,
				body: "human chatting idly",
				actor_kind: "human",
			}),
		];
		stubHistory(batch, 5);
		const r = injected(await pullAndFormat(baseState(0)));
		expect(r.triggerEligible).toBe(false);
		expect(r.content).toContain("human chatting idly");
	});
});

describe("pullAndFormat triggerEligible — mixed batch (OR)", () => {
	test("one direct @mention among ambient => triggerEligible true; all bodies injected", async () => {
		const batch = [
			msg({ cursor: 6, body: "ambient human", actor_kind: "human" }),
			msg({
				cursor: 7,
				body: "ambient agent",
				actor_kind: "agent",
				agent_id: OTHER_AGENT,
				mentions: [{ kind: "agent", id: OTHER_AGENT, name: "other" }],
			}),
			msg({
				cursor: 8,
				body: "yo @self check this",
				actor_kind: "agent",
				agent_id: OTHER_AGENT,
				mentions: [{ kind: "agent", id: SELF, name: "me" }],
			}),
		];
		stubHistory(batch, 8);
		const r = injected(await pullAndFormat(baseState(0)));
		expect(r.messageCount).toBe(3);
		expect(r.triggerEligible).toBe(true);
		// Every message remains visible (broadcast delivery preserved).
		expect(r.content).toContain("ambient human");
		expect(r.content).toContain("ambient agent");
		expect(r.content).toContain("yo @self check this");
	});
});

describe("pullAndFormat triggerEligible — clean cutover ambient + parse-error", () => {
	test("no mentions and no reply_to at all => ambient (triggerEligible false)", async () => {
		const batch = [msg({ cursor: 10, body: "bare ambient message" })];
		stubHistory(batch, 10);
		const r = injected(await pullAndFormat(baseState(0)));
		expect(r.triggerEligible).toBe(false);
	});
	test("unbound seat (selfAgentId null): mention would-be-self is ambient (no identity)", async () => {
		const batch = [
			msg({
				cursor: 11,
				body: "mention shape but seat unbound",
				mentions: [{ kind: "agent", id: SELF, name: "me" }],
			}),
		];
		stubHistory(batch, 11);
		const state = { ...baseState(0), selfAgentId: null };
		const r = injected(await pullAndFormat(state));
		expect(r.triggerEligible).toBe(false);
	});
	test("reply_to missing parent identity fails the page (parse_error, no cursor advance)", async () => {
		// Clean cutover: a present reply_to object MUST carry actor_kind + agent_id.
		// Missing identity fails the whole page rather than collapsing to ambient.
		stubRawHistory(
			[
				rawMsg({
					cursor: 9,
					body: "reply without parent identity",
					reply_to: { message_id: "m-8", cursor: 8, author_name: "who", snippet: "" },
				}),
			],
			9,
		);
		const r = await pullAndFormat(baseState(0));
		expect(r.kind).toBe("error");
		if (r.kind === "error") {
			expect(r.message).toContain("malformed");
			// Cursor must not advance past unseen content.
			expect(r.state.cursor).toBe(0);
		}
	});
});

describe("pullAndFormat non-injected outcomes have no triggerEligible", () => {
	test("no_room outcome", async () => {
		const state = { ...baseState(0), roomId: null };
		assertNoTriggerFlag(await pullAndFormat(state));
	});
	test("empty outcome (no messages)", async () => {
		stubHistory([], 0);
		assertNoTriggerFlag(await pullAndFormat(baseState(0)));
	});
	test("error outcome (bridge not started)", async () => {
		// beforeEach set bridge null -> callHuddoraTool returns no_host_api error.
		const r = await pullAndFormat(baseState(0));
		expect(r.kind).toBe("error");
		assertNoTriggerFlag(r);
	});
});

describe("pullAndFormat malformed durable history — sanitization before classification", () => {
	// Reproduction for dialogue-review medium finding: the durable path must
	// validate every message_history message's mentions/reply_to before
	// using the same defensive rules as the notification parser. A malformed
	// history value containing a matching self id but missing the required
	// name must NOT be classified as a structured self-mention (ambient, not
	// a wake). A reply_to object missing its mandatory parent identity fails
	// the page (clean cutover) rather than collapsing to ambient.
	test("malformed self-mention missing name => triggerEligible false (ambient)", async () => {
		// Server returned a mention entry with kind=agent + id=self but NO name.
		// A naive classifier would treat this as a structured self-mention wake.
		stubRawHistory(
			[
				rawMsg({
					cursor: 1,
					body: "malformed @self",
					mentions: [{ kind: "agent", id: SELF }],
				}),
			],
			1,
		);
		const r = injected(await pullAndFormat(baseState(0)));
		expect(r.triggerEligible).toBe(false);
		// Still injected as room context (visibility never filtered).
		expect(r.content).toContain("malformed @self");
	});

	test("malformed self-mention with non-string name => triggerEligible false", async () => {
		stubRawHistory(
			[
				rawMsg({
					cursor: 2,
					body: "non-string name @self",
					mentions: [{ kind: "agent", id: SELF, name: 42 }],
				}),
			],
			2,
		);
		const r = injected(await pullAndFormat(baseState(0)));
		expect(r.triggerEligible).toBe(false);
	});
	test("reply to a deleted-agent parent (agent_id null) is valid and ambient (no wake)", async () => {
		// Clean cutover: actor_kind=agent + agent_id=null is a valid parent
		// identity (deleted agent); not a self-reply, so it stays ambient.
		stubRawHistory(
			[
				rawMsg({
					cursor: 3,
					body: "reply to deleted agent parent",
					reply_to: {
						message_id: "m-1",
						cursor: 1,
						author_name: "me",
						snippet: "x",
						actor_kind: "agent",
						agent_id: null,
					},
				}),
			],
			3,
		);
		const r = injected(await pullAndFormat(baseState(0)));
		expect(r.triggerEligible).toBe(false);
		expect(r.content).toContain("reply to deleted agent parent");
	});

	test("reply_to with missing actor_kind fails the page (parse_error, no cursor advance)", async () => {
		// The reply_to object is structurally present but identity is malformed.
		stubRawHistory(
			[
				rawMsg({
					cursor: 7,
					body: "reply missing actor_kind",
					reply_to: {
						message_id: "m-6",
						cursor: 6,
						author_name: "p",
						snippet: "s",
						agent_id: SELF,
					},
				}),
			],
			7,
		);
		const r = await pullAndFormat(baseState(0));
		expect(r.kind).toBe("error");
		if (r.kind === "error") {
			expect(r.message).toContain("malformed");
			expect(r.state.cursor).toBe(0);
		}
	});

	test("valid self-mention through the same raw path still classifies direct (happy path)", async () => {
		// Guards against over-sanitization: a well-formed self-mention must
		// still wake through the sanitized durable path.
		stubRawHistory(
			[
				rawMsg({
					cursor: 4,
					body: "valid @self please do X",
					mentions: [{ kind: "agent", id: SELF, name: "me" }],
				}),
			],
			4,
		);
		const r = injected(await pullAndFormat(baseState(0)));
		expect(r.triggerEligible).toBe(true);
		expect(r.content).toContain("valid @self please do X");
	});

	test("message missing required fields fails the page (parse_error, no cursor advance)", async () => {
		// A raw entry lacking cursor/body (malformed) must fail the whole page:
		// silently dropping it while honoring next_cursor would advance past
		// unseen content. This is distinct from a valid nullable-author row.
		stubRawHistory(
			[
				// malformed: no cursor, no body, no author_id
				{ message_id: "junk" },
				// valid ambient would survive in isolation, but the malformed
				// sibling fails the entire page.
				rawMsg({ cursor: 5, body: "one good message" }),
			],
			5,
		);
		const r = await pullAndFormat(baseState(0));
		expect(r.kind).toBe("error");
		if (r.kind === "error") {
			expect(r.message).toContain("malformed");
			// Cursor must not advance — error outcome preserves state.cursor.
			expect(r.state.cursor).toBe(0);
		}
	});

	test("unbound seat: malformed self-id mention stays ambient (no identity)", async () => {
		// Even a valid-shaped mention cannot direct when selfAgentId is null.
		stubRawHistory(
			[
				rawMsg({
					cursor: 6,
					body: "mention before seat bound",
					mentions: [{ kind: "agent", id: SELF, name: "me" }],
				}),
			],
			6,
		);
		const state = { ...baseState(0), selfAgentId: null };
		const r = injected(await pullAndFormat(state));
		expect(r.triggerEligible).toBe(false);
	});
});

describe("pullAndFormat nullable author_id — retained former-member rows", () => {
	// Huddora legitimately emits author_id:null for retained former-member
	// / deleted-account messages. These are NOT malformed and must be kept,
	// injected, and never fail the page.
	test("all-null-author page: kept, injected, cursor advances, no crash", async () => {
		stubRawHistory(
			[
				{ cursor: 1, author_id: null, body: "ghost A" },
				{ cursor: 2, author_id: null, body: "ghost B" },
			],
			2,
		);
		const r = injected(await pullAndFormat(baseState(0)));
		expect(r.messageCount).toBe(2);
		// Bodies visible (visibility never filtered for null-author rows).
		expect(r.content).toContain("ghost A");
		expect(r.content).toContain("ghost B");
		// author label fallback must not slice null — renders "unknown".
		expect(r.content).toContain("author=unknown");
		// Cursor advances past the null-author batch — no parse_error.
		expect(r.cursorAfter).toBe(2);
	});

	test("mixed null/normal author page: every row kept and injected", async () => {
		stubRawHistory(
			[
				{ cursor: 1, author_id: null, body: "former member" },
				{ cursor: 2, author_id: "user-peer", author_name: "Peer", body: "current member" },
				{ cursor: 3, author_id: null, body: "another ghost" },
			],
			3,
		);
		const r = injected(await pullAndFormat(baseState(0)));
		expect(r.messageCount).toBe(3);
		expect(r.content).toContain("former member");
		expect(r.content).toContain("current member");
		expect(r.content).toContain("another ghost");
		// null-author rows get "unknown"; normal rows keep their name.
		expect(r.content).toContain("author=unknown");
		expect(r.content).toContain("author=Peer");
		expect(r.cursorAfter).toBe(3);
	});
});

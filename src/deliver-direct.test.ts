/**
 * Pure direct-response classification + trigger-gating tests.
 * No OMP imports; exercises classifyDirect / isDirectBatch / gateInject only.
 *
 * Rule (per agent-dialogue-contract):
 *   A message directly addresses this seat when:
 *     - mentions contains { kind: "agent", id: selfAgentId }, or
 *     - reply_to.actor_kind == "agent" && reply_to.agent_id == selfAgentId.
 *   reply_to is only ever present with a complete parent identity (actor_kind +
 *   agent_id); malformed identity is rejected by the sanitizer before reaching
 *   this classifier, so absent identity is never seen here.
 *   Idle: direct batch => trigger; ambient batch => inject context, no trigger.
 *   Active: steer/followUp regardless of triggerEligible (context can steer).
 */
import { describe, expect, test } from "bun:test";
import {
	type ClassifiableMessage,
	RATE_MAX_INJECTS_PER_MIN,
	classifyDirect,
	defaultRateGuard,
	gateInject,
	isDirectBatch,
} from "./deliver";

const SELF = "agent-self-id";
type Msg = ClassifiableMessage;

function directMsg(partial: Partial<Msg> = {}): Msg {
	return { ...partial };
}

describe("classifyDirect — direct mention of self", () => {
	test("agent mention matching selfAgentId is direct", () => {
		const m = directMsg({ mentions: [{ kind: "agent", id: SELF, name: "Me" }] });
		expect(classifyDirect(m, SELF)).toBe(true);
	});

	test("agent mention of a different agent is NOT direct", () => {
		const m = directMsg({ mentions: [{ kind: "agent", id: "other-agent", name: "Other" }] });
		expect(classifyDirect(m, SELF)).toBe(false);
	});

	test("human mention of self is NOT direct (only agent mentions count)", () => {
		const m = directMsg({ mentions: [{ kind: "human", id: SELF, name: "Me" }] });
		expect(classifyDirect(m, SELF)).toBe(false);
	});

	test("mention list with self among others is direct", () => {
		const m = directMsg({
			mentions: [
				{ kind: "agent", id: "other", name: "A" },
				{ kind: "agent", id: SELF, name: "Me" },
			],
		});
		expect(classifyDirect(m, SELF)).toBe(true);
	});

	test("empty mentions does not classify direct", () => {
		expect(classifyDirect(directMsg({ mentions: [] }), SELF)).toBe(false);
	});
});

describe("classifyDirect — reply-to-self agent (parent authored by this seat)", () => {
	test("reply whose parent actor_kind=agent and agent_id==self is direct", () => {
		const m = directMsg({ reply_to: { actor_kind: "agent", agent_id: SELF } });
		expect(classifyDirect(m, SELF)).toBe(true);
	});

	test("reply whose parent actor_kind=human is NOT direct even if agent_id matches", () => {
		const m = directMsg({ reply_to: { actor_kind: "human", agent_id: SELF } });
		expect(classifyDirect(m, SELF)).toBe(false);
	});

	test("reply whose parent agent_id is a different agent is NOT direct", () => {
		const m = directMsg({ reply_to: { actor_kind: "agent", agent_id: "other-agent" } });
		expect(classifyDirect(m, SELF)).toBe(false);
	});
});

describe("isDirectBatch — batch classification (OR across messages)", () => {
	test("batch is direct if ANY message directly addresses self", () => {
		const batch = [
			directMsg({ mentions: [{ kind: "agent", id: "other", name: "A" }] }),
			directMsg({ mentions: [{ kind: "agent", id: SELF, name: "Me" }] }),
		];
		expect(isDirectBatch(batch, SELF)).toBe(true);
	});

	test("ambient agent-only batch is NOT direct", () => {
		const batch = [
			directMsg({ mentions: [{ kind: "agent", id: "other", name: "A" }] }),
			directMsg({ reply_to: { actor_kind: "agent", agent_id: "other" } }),
		];
		expect(isDirectBatch(batch, SELF)).toBe(false);
	});

	test("human ambient batch is NOT direct", () => {
		const batch = [directMsg({ mentions: [{ kind: "human", id: "u1", name: "U" }] })];
		expect(isDirectBatch(batch, SELF)).toBe(false);
	});

	test("mixed batch with one direct @mention is direct (trigger-eligible)", () => {
		const batch = [
			directMsg({ mentions: [{ kind: "human", id: "u1", name: "U" }] }),
			directMsg({ mentions: [{ kind: "agent", id: "other", name: "A" }] }),
			directMsg({ mentions: [{ kind: "agent", id: SELF, name: "Me" }] }),
		];
		expect(isDirectBatch(batch, SELF)).toBe(true);
	});

	test("empty batch is NOT direct", () => {
		expect(isDirectBatch([], SELF)).toBe(false);
	});
});

describe("ambient batches never classify direct", () => {
	test("no mentions, no reply_to => ambient", () => {
		expect(classifyDirect(directMsg(), SELF)).toBe(false);
	});

	test("mention without kind key signature is ambient (only agent mentions of self count)", () => {
		// A mention entry shaped as a human mentioning this seat is ambient —
		// only structured { kind: "agent", id: self } mentions are direct.
		const m = directMsg({ mentions: [{ kind: "human", id: SELF, name: "Me" }] });
		expect(classifyDirect(m, SELF)).toBe(false);
	});

	test("batch of all-ambient messages => ambient", () => {
		expect(isDirectBatch([directMsg(), directMsg(), directMsg()], SELF)).toBe(false);
	});

	test("null selfAgentId => ambient (unbound seat)", () => {
		const m = directMsg({ mentions: [{ kind: "agent", id: SELF, name: "Me" }] });
		expect(classifyDirect(m, null)).toBe(false);
		expect(isDirectBatch([m], null)).toBe(false);
	});

	test("reply_to agent parent whose agent_id is null (human/deleted) is ambient for an agent seat", () => {
		// A null agent_id parent is a human/deleted-agent parent — never a
		// self reply, so it must not wake an agent seat.
		const m = directMsg({ reply_to: { actor_kind: "agent", agent_id: null } });
		expect(classifyDirect(m, SELF)).toBe(false);
	});
});

describe("gateInject triggerEligible — idle ambient does not wake", () => {
	test("idle DIRECT batch: nextTurn + triggerTurn", () => {
		const r = gateInject(defaultRateGuard(), {
			isIdle: true,
			content: "hi self",
			now: 1_000,
			triggerEligible: true,
		});
		expect(r?.options).toEqual({ deliverAs: "nextTurn", triggerTurn: true });
	});

	test("idle AMBIENT batch: nextTurn, triggerTurn false (context only, no wake)", () => {
		const r = gateInject(defaultRateGuard(), {
			isIdle: true,
			content: "ambient noise",
			now: 1_000,
			triggerEligible: false,
		});
		expect(r?.options).toEqual({ deliverAs: "nextTurn", triggerTurn: false });
		expect(r).not.toBeNull(); // still injected
	});

	test("idle ambient default (triggerEligible omitted) behaves as direct: triggers", () => {
		// Default preserves prior behavior: omitting the flag means eligible.
		const r = gateInject(defaultRateGuard(), {
			isIdle: true,
			content: "legacy",
			now: 1_000,
		});
		expect(r?.options.triggerTurn).toBe(true);
	});
	test("active turn is steer regardless of triggerEligible (context can steer)", () => {
		const direct = gateInject(defaultRateGuard(), {
			isIdle: false,
			content: "steer me",
			now: 5_000,
			triggerEligible: true,
		});
		expect(direct?.options).toEqual({ deliverAs: "steer", triggerTurn: false });

		// Fresh guard so the steer cooldown does not coalesce; ambient path is still steer.
		const ambient = gateInject(defaultRateGuard(), {
			isIdle: false,
			content: "steer ambient",
			now: 50_000,
			triggerEligible: false,
		});
		expect(ambient?.options).toEqual({ deliverAs: "steer", triggerTurn: false });
	});

	test("active steer-cooldown coalesce falls to followUp (never-trigger, ambient-independent)", () => {
		const g0 = defaultRateGuard();
		const first = gateInject(g0, {
			isIdle: false,
			content: "a",
			now: 10_000,
			triggerEligible: false,
		});
		expect(first?.options).toEqual({ deliverAs: "steer", triggerTurn: false });
		// Within RATE_STEER_MIN_MS window -> coalesce to followUp.
		const second = gateInject(first!.guard, {
			isIdle: false,
			content: "b",
			now: 10_000 + 1_000,
			triggerEligible: false,
		});
		expect(second?.options.deliverAs).toBe("followUp");
		expect(second?.options.triggerTurn).toBe(false);
	});
});

describe("gateInject triggerEligible — ambient dedupe still respected", () => {
	test("identical ambient body still dedupes (dropped)", () => {
		const g0 = defaultRateGuard();
		const r1 = gateInject(g0, {
			isIdle: true,
			content: "same ambient",
			now: 1_000,
			triggerEligible: false,
		});
		expect(r1?.options.triggerTurn).toBe(false);
		const r2 = gateInject(r1!.guard, {
			isIdle: true,
			content: "same ambient",
			now: 2_000,
			triggerEligible: false,
		});
		expect(r2).toBeNull();
	});
});


describe("ambient traffic does not starve direct wake (rate guard)", () => {
	// Reproduction for dialogue-review high finding: six ambient idle batches
	// must NOT exhaust the shared rate budget that gates direct idle wakes.
	// An eligible idle batch carries a real direct address and must still wake.
	test("six idle AMBIENT batches then a DIRECT batch: direct still wakes", () => {
		let g = defaultRateGuard();
		const base = 5_000_000;
		// Six ambient context-only idle injections within the rate window.
		for (let i = 0; i < RATE_MAX_INJECTS_PER_MIN; i++) {
			const r = gateInject(g, {
				isIdle: true,
				content: `ambient-${i}`,
				now: base + i * 10,
				triggerEligible: false,
			});
			expect(r).not.toBeNull();
			expect(r?.options.triggerTurn).toBe(false);
			// Ambient context injections must not consume the wake budget.
			expect(r?.guard.injectTimes.length).toBe(0);
			g = r!.guard;
		}
		// The very next batch directly addresses this seat after ambient traffic.
		const direct = gateInject(g, {
			isIdle: true,
			content: "hey @self please do X",
			now: base + 70,
			triggerEligible: true,
		});
		expect(direct).not.toBeNull();
		expect(direct?.options).toEqual({ deliverAs: "nextTurn", triggerTurn: true });
	});

	test("ambient idle batches leave injectTimes empty across many batches", () => {
		let g = defaultRateGuard();
		const base = 9_000_000;
		// Far more than the per-minute cap, all ambient — none must grow the budget.
		for (let i = 0; i < RATE_MAX_INJECTS_PER_MIN * 3; i++) {
			const r = gateInject(g, {
				isIdle: true,
				content: `ambient-${i}`,
				now: base + i * 5,
				triggerEligible: false,
			});
			expect(r).not.toBeNull();
			expect(r?.guard.injectTimes.length).toBe(0);
			g = r!.guard;
		}
		// A direct wake immediately after still goes through.
		const direct = gateInject(g, {
			isIdle: true,
			content: "direct after flood",
			now: base + RATE_MAX_INJECTS_PER_MIN * 3 * 5,
			triggerEligible: true,
		});
		expect(direct?.options.triggerTurn).toBe(true);
	});
});

describe("queueInject rejection retains cursor (retry after rate window)", () => {
	// Reproduction for dialogue-review high finding: when gating drops an idle
	// batch (rate/dedupe), the caller must NOT persist the advanced cursor — the
	// batch must be retried after the rate window. This models the contract at the
	// gate boundary the callers rely on: a dropped batch returns null so
	// queueInject returns false, and the caller retains the previous cursor.
	test("over-budget INELIGIBLE idle batch is dropped (gateInject null)", () => {
		let g = defaultRateGuard();
		const base = 7_000_000;
		// Fill the wake budget with genuine wakes (eligible idle batches).
		for (let i = 0; i < RATE_MAX_INJECTS_PER_MIN; i++) {
			const r = gateInject(g, {
				isIdle: true,
				content: `wake-${i}`,
				now: base + i,
				triggerEligible: true,
			});
			expect(r?.options.triggerTurn).toBe(true);
			g = r!.guard;
		}
		// Seventh batch is ineligible (ambient room context) while over budget.
		const dropped = gateInject(g, {
			isIdle: true,
			content: "ambient over budget",
			now: base + RATE_MAX_INJECTS_PER_MIN,
			triggerEligible: false,
		});
		// queueInject would return false here; the caller must retain the cursor.
		expect(dropped).toBeNull();
	});

	test("an eligible idle batch is NOT dropped even when ambient filled earlier wakes — retry-after-window bound", () => {
		// Confirm the eligible path survives the rate window via existing scheduling:
		// after 60s drift, the bucket drains and a fresh eligible batch wakes again.
		let g = defaultRateGuard();
		const base = 8_000_000;
		for (let i = 0; i < RATE_MAX_INJECTS_PER_MIN; i++) {
			const r = gateInject(g, {
				isIdle: true,
				content: `wake-${i}`,
				now: base + i,
				triggerEligible: true,
			});
			g = r!.guard;
		}
		// Past the 60s rate window: a fresh eligible idle batch wakes cleanly.
		const retry = gateInject(g, {
			isIdle: true,
			content: "late direct message",
			now: base + 61_000,
			triggerEligible: true,
		});
		expect(retry).not.toBeNull();
		expect(retry?.options.triggerTurn).toBe(true);
		// The retry consumes exactly one slot (bounded wake, not a tight replay loop).
		expect(retry?.guard.injectTimes.length).toBe(1);
	});
});

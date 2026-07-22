import { describe, expect, test } from "bun:test";
import {
	connected,
	disconnected,
	paused,
	preempted,
	pushPreference,
	resumed,
	roomNeeded,
	syncResult,
	transportUnavailable,
} from "./human-messages";

// Forbidden operator jargon that must never appear in user-facing notifications.
// Mirrors the vocabulary banned in presentation.test.ts.
const FORBIDDEN = [
	"bridge",
	"courier-primary",
	"courier_primary",
	"courier",
	"lease_ttl",
	"seat stamp",
	"MCPManager",
	"mute-trap",
	"mute_trap",
	"xd://",
	"session_key",
	"room_snapshot",
	"room_list",
	"agent_not_bound",
	"agent_preempted",
	"bound_elsewhere",
	"extension_version",
	"in-flight",
	"inflight",
	"cursor",
	"operator",
];

/** Collect every exported notification string so a single sweep covers them all. */
function allStrings(): string[] {
	return [
		transportUnavailable(),
		transportUnavailable("sync"),
		transportUnavailable("connect", "401 Unauthorized"),
		transportUnavailable(undefined, "OAuth token expired"),
		transportUnavailable(undefined, "connection rejected"),
		roomNeeded(),
		connected(),
		connected("Slupport"),
		connected("Slupport", true),
		connected(null, true),
		connected("  "),
		paused(),
		resumed(),
		disconnected(),
		syncResult({ newMessages: 0 }),
		syncResult({ newMessages: 1 }),
		syncResult({ newMessages: 42 }),
		syncResult({ newMessages: 0, error: "timeout" }),
		syncResult({ newMessages: 5, error: "server error" }),
		preempted(),
		pushPreference(true),
		pushPreference(false),
	];
}

describe("human-messages forbidden-jargon sweep", () => {
	test("no forbidden operator term leaks into any notification", () => {
		for (const s of allStrings()) {
			for (const term of FORBIDDEN) {
				expect(s).not.toContain(term);
			}
		}
	});
});

describe("human-messages prefix consistency", () => {
	test("every notification starts with 'Huddora:'", () => {
		for (const s of allStrings()) {
			expect(s.startsWith("Huddora:")).toBe(true);
		}
	});
});

describe("transportUnavailable", () => {
	test("default: points at /huddora connect (no reauth)", () => {
		const s = transportUnavailable();
		expect(s).toContain("/huddora connect");
		expect(s).not.toContain("/mcp reauth");
	});

	test("with action verb includes contextual 'during'", () => {
		const s = transportUnavailable("sync");
		expect(s).toContain("during sync");
	});

	test("credential error suggests /mcp reauth huddora then /huddora connect", () => {
		const s = transportUnavailable(undefined, "401 Unauthorized");
		expect(s).toContain("/mcp reauth huddora");
		expect(s).toContain("/huddora connect");
	});

	test("OAuth/expired error triggers reauth suggestion", () => {
		const s = transportUnavailable("sync", "OAuth token expired");
		expect(s).toContain("/mcp reauth huddora");
	});

	test("non-credential error does not suggest reauth", () => {
		const s = transportUnavailable(undefined, "connection rejected");
		expect(s).not.toContain("/mcp reauth");
		expect(s).toContain("/huddora connect");
	});
});

describe("roomNeeded", () => {
	test("mentions create/join, site, and /huddora room", () => {
		const s = roomNeeded();
		expect(s).toMatch(/create or join/i);
		expect(s).toContain("huddora.coolthings.fyi");
		expect(s).toContain("/huddora room");
	});
});

describe("connected", () => {
	test("no room name and not remembered is a bare success", () => {
		const s = connected();
		expect(s).toBe("Huddora: connected.");
	});

	test("room name appears in the message", () => {
		const s = connected("Slupport");
		expect(s).toContain("to Slupport");
	});

	test("remembered adds config note", () => {
		const s = connected("Slupport", true);
		expect(s).toContain("room saved to project config");
	});

	test("blank room name is treated as absent", () => {
		expect(connected("  ")).not.toContain("to  ");
		expect(connected(null)).not.toContain("to null");
	});
});

describe("paused and resumed", () => {
	test("paused mentions resume action", () => {
		expect(paused()).toContain("/huddora resume");
	});

	test("resumed is a clean affirmative", () => {
		expect(resumed()).toBe("Huddora: updates resumed.");
	});
});

describe("disconnected", () => {
	test("points at /huddora connect", () => {
		expect(disconnected()).toContain("/huddora connect");
	});
});

describe("syncResult", () => {
	test("zero new messages is 'up to date'", () => {
		const s = syncResult({ newMessages: 0 });
		expect(s).toContain("up to date");
		expect(s).toContain("no new messages");
	});

	test("exactly one message uses singular", () => {
		expect(syncResult({ newMessages: 1 })).toContain("1 new message");
	});

	test("multiple messages uses plural", () => {
		expect(syncResult({ newMessages: 42 })).toContain("42 new messages");
	});

	test("error produces a failure message with retry hint", () => {
		const s = syncResult({ newMessages: 0, error: "timeout" });
		expect(s).toContain("sync failed");
		expect(s).toContain("timeout");
		expect(s).toContain("/huddora sync");
	});

	test("error does not report new message count", () => {
		const s = syncResult({ newMessages: 5, error: "server error" });
		expect(s).not.toMatch(/\d+ new message/);
	});
});

describe("preempted", () => {
	test("mentions another window and /huddora connect", () => {
		const s = preempted();
		expect(s).toMatch(/another window/i);
		expect(s).toContain("/huddora connect");
	});
});

describe("pushPreference", () => {
	test("on yields live updates on", () => {
		expect(pushPreference(true)).toBe("Huddora: live updates on.");
	});

	test("off yields live updates off", () => {
		expect(pushPreference(false)).toBe("Huddora: live updates off.");
	});
});

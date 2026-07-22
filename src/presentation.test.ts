import { describe, expect, test } from "bun:test";
import {
	CONFIG_STATUS_VALUES,
	type ConfigStatus,
	type DeliveryLight,
	type HumanPresence,
	type HumanProblem,
	type HumanStatusInput,
	diagnoseHumanProblem,
	formatHumanDoctor,
	formatHumanStatus,
} from "./presentation";

const healthy: HumanStatusInput = {
	pluginVersion: "0.3.25",
	agentLabel: "Alice's OMP",
	agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	roomLabel: "Slupport",
	roomId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	presence: "online",
	paused: false,
	connection: "connected",
	configStatus: "valid",
	lastError: null,
	deliveryLight: "green",
};

/** Confirm every ConfigStatus value matches the runtime literal list. */
test("ConfigStatus union is exactly valid|missing|invalid", () => {
	expect(CONFIG_STATUS_VALUES).toEqual(["valid", "missing", "invalid"]);
});

describe("diagnoseHumanProblem", () => {
	test("healthy snapshot returns null", () => {
		expect(diagnoseHumanProblem(healthy)).toBeNull();
	});

	test("no room returns a warning problem", () => {
		const out = diagnoseHumanProblem({ ...healthy, roomId: null, roomLabel: null });
		expect(out).not.toBeNull();
		const p = out as HumanProblem;
		expect(p.title).toBe("No room bound");
		expect(p.level).toBe("warning");
		expect(p.fix).toMatch(/huddora\.coolthings\.fyi/);
	});

	test("OAuth/401 error returns the reauth problem", () => {
		const out = diagnoseHumanProblem({
			...healthy,
			lastError: "401 Unauthorized: reauth required",
		});
		expect(out).not.toBeNull();
		const p = out as HumanProblem;
		expect(p.title).toBe("OAuth token missing or expired");
		expect(p.fix).toMatch(/\/mcp reauth huddora/);
	});

	test("revoked presence is more specific than OAuth", () => {
		const out = diagnoseHumanProblem({
			...healthy,
			presence: "revoked",
			lastError: "401 token expired",
		});
		expect(out).not.toBeNull();
		const p = out as HumanProblem;
		expect(p.title).toBe("Agent access revoked");
		expect(p.level).toBe("error");
	});

	test("preempted connection returns another-window problem", () => {
		const out = diagnoseHumanProblem({
			...healthy,
			lastError: "agent_preempted: seat taken by another session",
		});
		expect(out).not.toBeNull();
		const p = out as HumanProblem;
		expect(p.title).toBe("Another window connected");
		expect(p.cause).not.toMatch(/seat|session|preempt/);
		expect(p.fix).toMatch(/\/huddora connect/);
	});

	test("invalid config returns config problem", () => {
		const out = diagnoseHumanProblem({ ...healthy, configStatus: "invalid" });
		expect(out).not.toBeNull();
		const p = out as HumanProblem;
		expect(p.title).toBe("Invalid Huddora config");
		expect(p.level).toBe("error");
		expect(p.fix).toMatch(/\.huddora\/config\.json/);
	});
});

describe("formatHumanStatus", () => {
	test("lobby card has exactly one Next line", () => {
		const out = formatHumanStatus(healthy);
		const nextLines = out.split("\n").filter((l) => l.startsWith("Next:"));
		expect(nextLines.length).toBe(1);
	});

	test("bound room places full room_id on its own line for copy/paste", () => {
		const out = formatHumanStatus(healthy);
		const lines = out.split("\n");
		expect(lines).toContain(healthy.roomId);
		// room_id line is not appended with model instructions.
		const rid = lines.find((l) => l === healthy.roomId) ?? "";
		expect(rid).not.toMatch(/room_snapshot|room_list|skip/);
	});

	test("unbound room shows none and Next points at room setup", () => {
		const out = formatHumanStatus({ ...healthy, roomId: null, roomLabel: null });
		const lines = out.split("\n");
		expect(lines.some((l) => l === "Room: none")).toBe(true);
		const next = lines.find((l) => l.startsWith("Next:"));
		expect(next).toMatch(/No room bound|huddora\.coolthings\.fyi/);
	});

	test("status contains no forbidden operator jargon", () => {
		const forbidden = [
			"bridge",
			"courier-primary",
			"courier_primary",
			"lease_ttl",
			"seat stamp",
			"seat",
			"MCPManager",
			"MCP transport",
			"backend",
			"mute-trap",
			"mute_trap",
			"xd://",
			"session_key",
			"room_snapshot",
			"room_list",
			"agent_not_bound",
			"agent_preempted",
			"preempted",
			"bound_elsewhere",
			"extension_version",
			"last seat stamp",
			"ariable aUC",
		];
		const cases: HumanStatusInput[] = [
			healthy,
			{ ...healthy, roomId: null, roomLabel: null, presence: "needs_setup" },
			{ ...healthy, presence: "revoked", lastError: "revoked" },
			{ ...healthy, lastError: "401 Unauthorized: reauth required" },
			{ ...healthy, lastError: "agent_preempted: seat taken" },
			{ ...healthy, configStatus: "invalid" },
			{ ...healthy, presence: "offline", connection: "disconnected" },
		];
		for (const input of cases) {
			const out = formatHumanStatus(input);
			for (const term of forbidden) {
				expect(out).not.toContain(term);
			}
		}
	});

	test("paused overrides online with Away state label", () => {
		const out = formatHumanStatus({ ...healthy, paused: true });
		expect(out.split("\n")[0]).toMatch(/Away/);
	});

	test("state labels render the agreed title-cased vocabulary", () => {
		const first = (input: HumanStatusInput) => formatHumanStatus(input).split("\n")[0];
		expect(first(healthy)).toMatch(/— Ready$/);
		expect(first({ ...healthy, paused: true })).toMatch(/— Away$/);
		expect(first({ ...healthy, presence: "offline" as const })).toMatch(/— Away$/);
		expect(first({ ...healthy, presence: "needs_setup" as const, roomId: null, roomLabel: null })).toMatch(/— Needs setup$/);
		expect(first({ ...healthy, lastError: "preempted — rebind unbound" })).toMatch(/— Needs reconnect$/);
		expect(first({ ...healthy, presence: "revoked" as const, lastError: "revoked" })).toMatch(/— Revoked$/);
	});
});

describe("formatHumanDoctor", () => {
	test("null problem yields exactly one healthy summary line", () => {
		const out = formatHumanDoctor(null);
		expect(out.split("\n")).toEqual(["Huddora looks healthy."]);
	});

	test("problem yields exactly three lines: title, cause, fix", () => {
		const problem: HumanProblem = {
			title: "OAuth token missing or expired",
			cause: "The Huddora MCP connection lost its OAuth token (expired or revoked by the provider).",
			fix: "Run /mcp reauth huddora to refresh the OAuth token, then /huddora connect.",
			level: "warning",
		};
		const out = formatHumanDoctor(problem);
		expect(out.split("\n")).toHaveLength(3);
		expect(out).toContain(problem.title);
		expect(out).toContain(problem.cause);
		expect(out).toContain(problem.fix);
	});
});

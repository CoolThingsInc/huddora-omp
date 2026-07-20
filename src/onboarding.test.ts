import { describe, expect, test } from "bun:test";
import {
	decideRoomBinding,
	doctorNextStep,
	nextOnboardingDelayMs,
	roomToolFailureMessage,
	shouldResetOnboardingBudget,
} from "./onboarding";

describe("onboarding observer policy", () => {
	test("aggressive budget then forever re-arm delay", () => {
		expect(nextOnboardingDelayMs(0)).toBe(1_000);
		expect(nextOnboardingDelayMs(1)).toBe(2_000);
		expect(nextOnboardingDelayMs(5)).toBe(32_000 > 30_000 ? 30_000 : 32_000);
		expect(nextOnboardingDelayMs(5)).toBe(30_000); // 1000 * 2^5 = 32000 capped
		expect(nextOnboardingDelayMs(6)).toBe(30_000);
		expect(nextOnboardingDelayMs(7)).toBe(15_000);
		expect(nextOnboardingDelayMs(20)).toBe(15_000);
	});

	test("status change re-arms budget; first sample does not", () => {
		expect(shouldResetOnboardingBudget(null, "disconnected")).toBe(false);
		expect(shouldResetOnboardingBudget("disconnected", "disconnected")).toBe(false);
		expect(shouldResetOnboardingBudget("disconnected", "connected")).toBe(true);
		expect(shouldResetOnboardingBudget("no_host_api", "connected")).toBe(true);
		expect(shouldResetOnboardingBudget("connecting", "connected")).toBe(true);
	});
});

describe("doctorNextStep auto-bridge", () => {
	test("bridge_missing never recommends reauth", () => {
		expect(
			doctorNextStep({ roomId: null, connection: "bridge_missing", delivery: "unknown" }),
		).toBe("wait for auto-connect or run /huddora connect");
	});

	test("no_manager legacy status never recommends reauth", () => {
		expect(
			doctorNextStep({ roomId: null, connection: "no_manager", delivery: "unknown" }),
		).toBe("wait for auto-connect or run /huddora connect");
	});

	test("bridge active points at room bind", () => {
		expect(
			doctorNextStep({ roomId: null, connection: "bridge", delivery: "bridge" }),
		).toBe("wait for auto-bind or run /huddora room");
	});

	test("oauth errors may reauth", () => {
		expect(
			doctorNextStep({
				roomId: null,
				connection: "bridge_missing",
				delivery: "unknown",
				bridgeError: "Huddora MCP session needs fresh OAuth",
			}),
		).toContain("reauth");
	});

	test("roomToolFailureMessage no_host_api is not reauth-first", () => {
		const msg = roomToolFailureMessage({ kind: "no_host_api", message: "x" });
		expect(msg.toLowerCase()).not.toMatch(/^run \/mcp reauth/);
		expect(msg.toLowerCase()).toContain("connect");
	});
});

describe("room bind decision (B5 + sole/config matrix)", () => {
	const rootA = "/tmp/project-a";
	const rootB = "/tmp/project-b";
	const room1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const room2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

	test("config room wins over session and sole-room", () => {
		expect(
			decideRoomBinding({
				root: rootA,
				configRoomId: room1,
				stateRoomId: room2,
				stateProjectRoot: null,
				rooms: [{ room_id: room2 }],
				transportReady: true,
			}),
		).toEqual({ action: "bind", roomId: room1, source: "config", preserveCursor: false });
	});

	test("legacy v0.2 session room binds ephemerally with cursor preserved", () => {
		expect(
			decideRoomBinding({
				root: rootA,
				configRoomId: null,
				stateRoomId: room1,
				stateProjectRoot: null,
				rooms: [{ room_id: room1 }, { room_id: room2 }],
				transportReady: true,
			}),
		).toEqual({ action: "bind", roomId: room1, source: "legacy", preserveCursor: true });
	});

	test("sole room binds when no config and no legacy", () => {
		expect(
			decideRoomBinding({
				root: rootA,
				configRoomId: null,
				stateRoomId: null,
				stateProjectRoot: null,
				rooms: [{ room_id: room1 }],
				transportReady: true,
			}),
		).toEqual({ action: "bind", roomId: room1, source: "single", preserveCursor: false });
	});

	test("multi-room without config prompts choose", () => {
		expect(
			decideRoomBinding({
				root: rootA,
				configRoomId: null,
				stateRoomId: null,
				stateProjectRoot: null,
				rooms: [{ room_id: room1 }, { room_id: room2 }],
				transportReady: true,
			}),
		).toEqual({ action: "prompt_choose" });
	});

	test("empty rooms prompt empty", () => {
		expect(
			decideRoomBinding({
				root: rootA,
				configRoomId: null,
				stateRoomId: null,
				stateProjectRoot: null,
				rooms: [],
				transportReady: true,
			}),
		).toEqual({ action: "prompt_empty" });
	});

	test("same-root already-bound reuses without re-bootstrap flood", () => {
		expect(
			decideRoomBinding({
				root: rootA,
				configRoomId: room1,
				stateRoomId: room1,
				stateProjectRoot: rootA,
				rooms: [{ room_id: room1 }],
				transportReady: true,
			}),
		).toEqual({ action: "reuse" });
	});

	test("changed project root clears prior room before rebinding", () => {
		expect(
			decideRoomBinding({
				root: rootB,
				configRoomId: null,
				stateRoomId: room1,
				stateProjectRoot: rootA,
				rooms: [{ room_id: room1 }],
				transportReady: true,
			}),
		).toEqual({ action: "clear_root" });
	});

	test("waits for transport when disconnected", () => {
		expect(
			decideRoomBinding({
				root: rootA,
				configRoomId: room1,
				stateRoomId: null,
				stateProjectRoot: null,
				rooms: [],
				transportReady: false,
			}),
		).toEqual({ action: "wait_transport" });
	});
});

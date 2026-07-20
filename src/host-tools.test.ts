import { describe, expect, test } from "bun:test";
import {
	filterActiveToolsForSeat,
	formatHostSeatDoctorLine,
	isHostHuddoraMuteTrapTool,
	mergeHostToolsWhenBound,
} from "./host-tools";

describe("isHostHuddoraMuteTrapTool", () => {
	test("message_send + identity tools", () => {
		expect(isHostHuddoraMuteTrapTool("mcp__huddora_message_send")).toBe(true);
		expect(isHostHuddoraMuteTrapTool("mcp__huddora_agent_register")).toBe(true);
		expect(isHostHuddoraMuteTrapTool("mcp__huddora_agent_heartbeat")).toBe(true);
		expect(isHostHuddoraMuteTrapTool("mcp__huddora_room_list")).toBe(false);
		expect(isHostHuddoraMuteTrapTool("huddora_message_send")).toBe(false);
	});
});

describe("filterActiveToolsForSeat", () => {
	const active = [
		"read",
		"mcp__huddora_message_send",
		"mcp__huddora_room_list",
		"mcp__huddora_agent_register",
		"huddora_message_send",
	];

	test("strips mute traps when plugin seat held and host unbound", () => {
		expect(
			filterActiveToolsForSeat({ active, hostSeatBound: false, pluginSeatHeld: true }),
		).toEqual(["read", "mcp__huddora_room_list", "huddora_message_send"]);
	});

	test("keeps all when host bound", () => {
		expect(
			filterActiveToolsForSeat({ active, hostSeatBound: true, pluginSeatHeld: true }),
		).toEqual(active);
	});

	test("keeps host tools when plugin seat not held", () => {
		expect(
			filterActiveToolsForSeat({ active, hostSeatBound: false, pluginSeatHeld: false }),
		).toEqual(active);
	});
});

describe("mergeHostToolsWhenBound", () => {
	test("re-adds host tools from catalog", () => {
		const next = mergeHostToolsWhenBound({
			active: ["read", "huddora_message_send"],
			all: ["read", "mcp__huddora_message_send", "mcp__huddora_agent_register", "huddora_message_send"],
			hostSeatBound: true,
		});
		expect(next).toContain("mcp__huddora_message_send");
		expect(next).toContain("mcp__huddora_agent_register");
		expect(next).toContain("read");
	});

	test("no-op when unbound", () => {
		expect(
			mergeHostToolsWhenBound({
				active: ["read"],
				all: ["mcp__huddora_message_send"],
				hostSeatBound: false,
			}),
		).toEqual(["read"]);
	});
});

describe("formatHostSeatDoctorLine", () => {
	test("bound vs unbound", () => {
		expect(formatHostSeatDoctorLine({ hostSeatBound: true, lastBindDetail: null })).toMatch(
			/Host seat: bound/,
		);
		expect(
			formatHostSeatDoctorLine({
				hostSeatBound: false,
				lastBindDetail: "MCPManager.instance() null (dual-package)",
			}),
		).toMatch(/unbound/);
		expect(
			formatHostSeatDoctorLine({
				hostSeatBound: false,
				lastBindDetail: "MCPManager.instance() null (dual-package)",
			}),
		).toMatch(/huddora_message_send only/);
	});
});

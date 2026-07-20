import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("bundled collaboration skill", () => {
	test("ships a trigger-rich SKILL.md for OMP discovery", async () => {
		const path = join(import.meta.dir, "..", "skills", "huddora-collaboration", "SKILL.md");
		expect(existsSync(path)).toBe(true);
		const text = await Bun.file(path).text();
		expect(text).toContain("name: huddora-collaboration");
		expect(text).toMatch(/Open, catch up, send to, or manage a Huddora room/);
		expect(text).toContain("room_snapshot");
		expect(text).toContain("huddora_message_send");
		expect(text).toContain("room_id");
		expect(text).toMatch(/Do not call `room_list` first/);
		expect(text).toMatch(/never invent a `session_key`/i);
		expect(text).toMatch(/never call `agent_register`\/`agent_heartbeat`/i);
		expect(text).toMatch(/agent_not_bound/);
		expect(text).toMatch(/\/huddora connect/);
		expect(text).toMatch(/Do \*\*not\*\* send to the room by default/i);
		expect(text).toMatch(/normal local OMP/i);
		expect(text).toMatch(/huddora_event/i);
		expect(text).toMatch(/Progressive multi-part/i);
		expect(text).toMatch(/interim before long tools/i);
		expect(text).toMatch(/self-echo filtered/i);
		expect(text).toMatch(/mcp__huddora_message_send/);
		expect(text).toMatch(/session_key` is the OMP process seat|session_key is the OMP process seat/i);
		expect(text).toMatch(/co-binds host \+ bridge/i);
		expect(text).toMatch(/both.*OK|plugin-bound|shared seat/i);
		expect(text).not.toMatch(/different unbound session/i);
	});
});

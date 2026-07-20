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
		expect(text).toContain("message_send");
		expect(text).toContain("room_id");
		expect(text).toMatch(/Do not call `room_list` first/);
		expect(text).toMatch(/never invent a `session_key`/i);
		expect(text).toMatch(/never call `agent_register` just in case/i);
		expect(text).toMatch(/agent_not_bound/);
		expect(text).toMatch(/\/huddora connect/);
	});
});

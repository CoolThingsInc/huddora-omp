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
	});
});

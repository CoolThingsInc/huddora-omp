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
		expect(text).toContain("xd://huddora_message_send");
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
		expect(text).toMatch(/one agent per \(machine × project\)|session_key` is plugin-local/i);
		expect(text).toMatch(/required model send path|plugin-bound|Host seat: bound/i);
		expect(text).toMatch(/mute-online trap|unsupported\/hidden|Host seat: bound/i);
		expect(text).not.toMatch(/both.*OK when footer online/i);
	});

	test("frontmatter meets the Agent Skills metadata contract", async () => {
		const path = join(import.meta.dir, "..", "skills", "huddora-collaboration", "SKILL.md");
		const text = await Bun.file(path).text();
		const fm = text.split("\n");
		expect(fm[0]).toBe("---");
		let body = -1;
		for (let i = 1; i < fm.length; i++) {
			if (fm[i] === "---") {
				body = i;
				break;
			}
		}
		expect(body).toBeGreaterThan(0);
		const front = fm.slice(1, body).join("\n");
		// metadata.version set to "1", no top-level version.
		expect(front).toMatch(/^metadata:$/m);
		expect(front).toMatch(/^  version: "1"$/m);
		expect(front).not.toMatch(/^version:/m);
		// name equals the directory name and stays kebab-case.
		expect(front).toMatch(/name: huddora-collaboration\b/);
		// description present and within budget.
		const desc = /description:\s*(.*)/.exec(front)?.[1] ?? "";
		expect(desc.length).toBeGreaterThan(0);
		expect(desc.length).toBeLessThanOrEqual(1024);
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PROJECT_CONFIG, loadProjectConfig, parseProjectConfig, writeProjectConfig } from "./project-config";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
async function root() {
	const path = await Bun.$`mktemp -d`.text();
	const value = path.trim();
	roots.push(value);
	return value;
}

describe("project config", () => {
	test("first run has safe defaults without creating a file", async () => {
		const project = await root();
		const loaded = await loadProjectConfig(project);
		expect(loaded).toMatchObject({ ok: true, exists: false, config: DEFAULT_PROJECT_CONFIG });
	});

	test("accepts only the documented shape and no secrets", () => {
		expect(parseProjectConfig({ ...DEFAULT_PROJECT_CONFIG, default_room_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }).default_room_id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
		expect(() => parseProjectConfig({ ...DEFAULT_PROJECT_CONFIG, token: "secret" })).toThrow("unknown config key");
		expect(() => parseProjectConfig({ ...DEFAULT_PROJECT_CONFIG, default_room_id: "not-a-uuid" })).toThrow("UUID");
	});

	test("writes atomically under the supplied project root with private mode", async () => {
		const project = await root();
		const path = await writeProjectConfig(project, DEFAULT_PROJECT_CONFIG);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(DEFAULT_PROJECT_CONFIG);
		const mode = (await Bun.file(path).stat()).mode;
		expect(mode & 0o077).toBe(0);
	});

	test("rejects a symlinked config directory", async () => {
		const project = await root();
		const outside = await root();
		await symlink(outside, join(project, ".huddora"));
		await expect(writeProjectConfig(project, DEFAULT_PROJECT_CONFIG)).rejects.toThrow("symlink");
	});

	test("concurrent writers leave valid JSON", async () => {
		const project = await root();
		await Promise.all(Array.from({ length: 8 }, () => writeProjectConfig(project, DEFAULT_PROJECT_CONFIG)));
		expect(await loadProjectConfig(project)).toMatchObject({ ok: true, config: DEFAULT_PROJECT_CONFIG });
	});
});

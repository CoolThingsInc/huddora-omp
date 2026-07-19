import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	DEFAULT_PROJECT_CONFIG,
	loadProjectConfig,
	parseProjectConfig,
	writeProjectConfig,
} from "./project-config";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
async function root() {
	const path = (await Bun.$`mktemp -d`.text()).trim();
	roots.push(path);
	return path;
}

describe("project config", () => {
	test("first run has safe defaults without creating a file", async () => {
		const project = await root();
		const loaded = await loadProjectConfig(project);
		expect(loaded).toMatchObject({ ok: true, exists: false, config: DEFAULT_PROJECT_CONFIG });
	});

	test("accepts only the documented shape and no secrets", () => {
		expect(
			parseProjectConfig({
				version: 1,
				default_room_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			}).default_room_id,
		).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
		expect(() => parseProjectConfig({ version: 1, default_room_id: null, token: "secret" })).toThrow(
			"unknown config key",
		);
		expect(() => parseProjectConfig({ version: 1, default_room_id: null, auto_connect: true })).toThrow(
			"unknown config key",
		);
		expect(() => parseProjectConfig({ version: 1, default_room_id: null, delivery: "push" })).toThrow(
			"unknown config key",
		);
		expect(() => parseProjectConfig({ version: 1, default_room_id: null, inject: "active-turn-and-idle" })).toThrow(
			"unknown config key",
		);
		expect(() => parseProjectConfig({ version: 1, default_room_id: "not-a-uuid" })).toThrow("UUID");
		expect(
			parseProjectConfig({
				$schema: "https://huddora.coolthings.fyi/schemas/project-config-v1.json",
				version: 1,
				default_room_id: null,
			}),
		).toEqual({ version: 1, default_room_id: null });
		expect(() =>
			parseProjectConfig({
				$schema: "https://evil.example/schema.json",
				version: 1,
				default_room_id: null,
			}),
		).toThrow("$schema");
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

	test("concurrent writers leave the last distinct room", async () => {
		const project = await root();
		const rooms = Array.from({ length: 8 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${i}`);
		await Promise.all(
			rooms.map(default_room_id => writeProjectConfig(project, { version: 1, default_room_id })),
		);
		const loaded = await loadProjectConfig(project);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(rooms).toContain(loaded.config.default_room_id);
		expect(JSON.parse(await readFile(loaded.path, "utf8"))).toEqual(loaded.config);
	});

	test("rejects adversarial file swap after validation", async () => {
		const project = await root();
		await writeProjectConfig(project, DEFAULT_PROJECT_CONFIG);
		const path = join(project, ".huddora", "config.json");
		await rm(path);
		await symlink("/etc/passwd", path);
		const loaded = await loadProjectConfig(project);
		expect(loaded.ok).toBe(false);
		if (loaded.ok) return;
		expect(loaded.error).toMatch(/regular file|symlink|NOFOLLOW|ELOOP/i);
	});
});

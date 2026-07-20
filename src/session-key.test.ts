import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultSessionKeyPath, ensureSessionKey, SESSION_KEY_DIR_ENV } from "./session-key";

const roots: string[] = [];
const prevEnv = process.env[SESSION_KEY_DIR_ENV];

afterEach(async () => {
	if (prevEnv === undefined) delete process.env[SESSION_KEY_DIR_ENV];
	else process.env[SESSION_KEY_DIR_ENV] = prevEnv;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const path = (await Bun.$`mktemp -d`.text()).trim();
	roots.push(path);
	return path;
}

describe("ensureSessionKey", () => {
	test("mints once, persists, and is idempotent", async () => {
		const dir = await tempDir();
		const filePath = join(dir, "session_key");
		const a = await ensureSessionKey({ filePath });
		const b = await ensureSessionKey({ filePath });
		expect(a).toBe(b);
		expect(a.length).toBeGreaterThanOrEqual(1);
		expect(a.length).toBeLessThanOrEqual(128);
		const onDisk = (await readFile(filePath, "utf8")).trim();
		expect(onDisk).toBe(a);
		const mode = (await Bun.file(filePath).stat()).mode;
		expect(mode & 0o077).toBe(0);
	});

	test("prefers file over fallback", async () => {
		const dir = await tempDir();
		const filePath = join(dir, "session_key");
		await writeFile(filePath, "file-key-aaaaaaaaaaaaaaaa\n", { mode: 0o600 });
		const key = await ensureSessionKey({ filePath, fallback: "fallback-key-bbbbbbbbbbbb" });
		expect(key).toBe("file-key-aaaaaaaaaaaaaaaa");
	});

	test("restores from fallback when file missing", async () => {
		const dir = await tempDir();
		const filePath = join(dir, "session_key");
		const key = await ensureSessionKey({ filePath, fallback: "fallback-key-cccccccccccc" });
		expect(key).toBe("fallback-key-cccccccccccc");
		expect((await readFile(filePath, "utf8")).trim()).toBe(key);
	});

	test("env dir override for default path", async () => {
		const dir = await tempDir();
		process.env[SESSION_KEY_DIR_ENV] = dir;
		expect(defaultSessionKeyPath()).toBe(join(dir, "session_key"));
		const key = await ensureSessionKey();
		expect((await readFile(join(dir, "session_key"), "utf8")).trim()).toBe(key);
	});

	test("rejects invalid existing content and remints", async () => {
		const dir = await tempDir();
		const filePath = join(dir, "session_key");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(filePath, "   \n", { mode: 0o600 });
		const key = await ensureSessionKey({ filePath });
		expect(key.length).toBeGreaterThan(0);
		expect((await readFile(filePath, "utf8")).trim()).toBe(key);
	});
});

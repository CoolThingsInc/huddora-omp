import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	currentOmpProfile,
	defaultSessionKeyPath,
	ensureSessionKey,
	processInstanceSessionKeyPath,
	SESSION_KEY_DIR_ENV,
} from "./session-key";

const roots: string[] = [];
const prevEnv = process.env[SESSION_KEY_DIR_ENV];
const prevProfile = process.env.OMP_PROFILE;
const prevPi = process.env.PI_PROFILE;

afterEach(async () => {
	if (prevEnv === undefined) delete process.env[SESSION_KEY_DIR_ENV];
	else process.env[SESSION_KEY_DIR_ENV] = prevEnv;
	if (prevProfile === undefined) delete process.env.OMP_PROFILE;
	else process.env.OMP_PROFILE = prevProfile;
	if (prevPi === undefined) delete process.env.PI_PROFILE;
	else process.env.PI_PROFILE = prevPi;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const path = (await Bun.$`mktemp -d`.text()).trim();
	roots.push(path);
	return path;
}

describe("ensureSessionKey", () => {
	test("branch state fallback wins (per OMP session seat)", async () => {
		const dir = await tempDir();
		const filePath = join(dir, "session_key");
		await writeFile(filePath, "file-key-should-not-win\n", { mode: 0o600 });
		const key = await ensureSessionKey({
			filePath,
			fallback: "branch-seat-aaaaaaaaaaaa",
		});
		expect(key).toBe("branch-seat-aaaaaaaaaaaa");
	});

	test("explicit file path mints once and is idempotent", async () => {
		const dir = await tempDir();
		const filePath = join(dir, "session_key");
		const a = await ensureSessionKey({ filePath });
		const b = await ensureSessionKey({ filePath });
		expect(a).toBe(b);
		expect(a.length).toBeGreaterThanOrEqual(1);
		expect(a.length).toBeLessThanOrEqual(128);
		const onDisk = (await readFile(filePath, "utf8")).trim();
		expect(onDisk).toBe(a);
	});

	test("two mints without shared fallback produce distinct seats (multi-OMP)", async () => {
		const a = await ensureSessionKey({ persistInstanceFile: false });
		const b = await ensureSessionKey({ persistInstanceFile: false });
		expect(a).not.toBe(b);
	});

	test("same branch fallback reuses seat across calls", async () => {
		const seat = "stable-omp-session-seat-key-01";
		const a = await ensureSessionKey({ fallback: seat, persistInstanceFile: false });
		const b = await ensureSessionKey({ fallback: seat, persistInstanceFile: false });
		expect(a).toBe(seat);
		expect(b).toBe(seat);
	});

	test("env dir + profile path for optional file seats", async () => {
		const dir = await tempDir();
		process.env[SESSION_KEY_DIR_ENV] = dir;
		process.env.OMP_PROFILE = "work";
		expect(defaultSessionKeyPath()).toBe(join(dir, "work", "session_key"));
		expect(processInstanceSessionKeyPath("work", "abc123").endsWith(join("work", "instance-abc123.key"))).toBe(
			true,
		);
	});

	test("rejects invalid existing content and remints on explicit path", async () => {
		const dir = await tempDir();
		const filePath = join(dir, "session_key");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(filePath, "   \n", { mode: 0o600 });
		const key = await ensureSessionKey({ filePath });
		expect(key.length).toBeGreaterThan(0);
		expect((await readFile(filePath, "utf8")).trim()).toBe(key);
	});

	test("currentOmpProfile reads OMP_PROFILE", () => {
		process.env.OMP_PROFILE = "desk";
		expect(currentOmpProfile()).toBe("desk");
	});
});

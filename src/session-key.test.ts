import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	currentOmpProfile,
	defaultSessionKeyPath,
	ensureSessionKey,
	projectIdFromRoot,
	projectSessionKeyPath,
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

describe("projectIdFromRoot", () => {
	test("same root → same project id", () => {
		expect(projectIdFromRoot("/Users/a/proj")).toBe(projectIdFromRoot("/Users/a/proj"));
	});

	test("different roots → different project ids", () => {
		expect(projectIdFromRoot("/tmp/a")).not.toBe(projectIdFromRoot("/tmp/b"));
	});
});

describe("ensureSessionKey (per-project durable)", () => {
	test("same project root reuses key (N windows / restart)", async () => {
		const store = await tempDir();
		process.env[SESSION_KEY_DIR_ENV] = store;
		const project = "/Users/me/apps/widget";
		const a = await ensureSessionKey({ projectRoot: project });
		const b = await ensureSessionKey({ projectRoot: project });
		expect(a.key).toBe(b.key);
		expect(a.minted).toBe(true);
		expect(b.minted).toBe(false);
		const path = projectSessionKeyPath(project);
		expect((await readFile(path, "utf8")).trim()).toBe(a.key);
	});

	test("different projects mint different keys", async () => {
		const store = await tempDir();
		process.env[SESSION_KEY_DIR_ENV] = store;
		const a = await ensureSessionKey({ projectRoot: "/proj/alpha" });
		const b = await ensureSessionKey({ projectRoot: "/proj/beta" });
		expect(a.key).not.toBe(b.key);
		expect(a.minted).toBe(true);
		expect(b.minted).toBe(true);
	});

	test("restart simulation: delete process memory, reload from file", async () => {
		const store = await tempDir();
		process.env[SESSION_KEY_DIR_ENV] = store;
		const project = "/work/repo";
		const first = await ensureSessionKey({ projectRoot: project });
		// simulate new process: only the file remains
		const second = await ensureSessionKey({ projectRoot: project, fallback: null });
		expect(second.key).toBe(first.key);
		expect(second.minted).toBe(false);
	});

	test("project file wins over stale branch fallback", async () => {
		const store = await tempDir();
		process.env[SESSION_KEY_DIR_ENV] = store;
		const project = "/work/stable";
		const durable = await ensureSessionKey({ projectRoot: project });
		const out = await ensureSessionKey({
			projectRoot: project,
			fallback: "stale-branch-seat-key-should-not-win",
		});
		expect(out.key).toBe(durable.key);
	});

	test("explicit file path mints once and is idempotent", async () => {
		const dir = await tempDir();
		const filePath = join(dir, "session_key");
		const a = await ensureSessionKey({ filePath });
		const b = await ensureSessionKey({ filePath });
		expect(a.key).toBe(b.key);
		expect(a.key.length).toBeGreaterThanOrEqual(1);
		expect(a.key.length).toBeLessThanOrEqual(128);
		const onDisk = (await readFile(filePath, "utf8")).trim();
		expect(onDisk).toBe(a.key);
	});

	test("fallback only used when no project/file path", async () => {
		const seat = "stable-omp-session-seat-key-01";
		const a = await ensureSessionKey({ fallback: seat });
		const b = await ensureSessionKey({ fallback: seat });
		expect(a.key).toBe(seat);
		expect(b.key).toBe(seat);
		expect(a.minted).toBe(false);
	});

	test("path layout under config root", async () => {
		const store = await tempDir();
		process.env[SESSION_KEY_DIR_ENV] = store;
		const project = "/Users/me/apps/widget";
		const id = projectIdFromRoot(project);
		expect(projectSessionKeyPath(project)).toBe(join(store, "projects", id, "session_key"));
		expect(defaultSessionKeyPath(project)).toBe(projectSessionKeyPath(project));
	});

	test("rejects invalid existing content and remints", async () => {
		const dir = await tempDir();
		const filePath = join(dir, "session_key");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(filePath, "   \n", { mode: 0o600 });
		const key = await ensureSessionKey({ filePath });
		expect(key.key.length).toBeGreaterThan(0);
		expect((await readFile(filePath, "utf8")).trim()).toBe(key.key);
	});

	test("currentOmpProfile reads OMP_PROFILE", () => {
		process.env.OMP_PROFILE = "desk";
		expect(currentOmpProfile()).toBe("desk");
	});
});

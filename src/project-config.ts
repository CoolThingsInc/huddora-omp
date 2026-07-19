import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const PROJECT_CONFIG_VERSION = 1;
export const PROJECT_CONFIG_FILENAME = ".huddora/config.json";

/** A non-authoritative room selection hint. Transport and delivery stay in session state. */
export type ProjectConfig = { version: 1; default_room_id: string | null };
export const DEFAULT_PROJECT_CONFIG: ProjectConfig = { version: PROJECT_CONFIG_VERSION, default_room_id: null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = new Set(["$schema", "version", "default_room_id"]);
const PINNED_SCHEMA = "https://huddora.coolthings.fyi/schemas/project-config-v1.json";
const LOCK_RETRY_MS = 20;
const LOCK_RETRIES = 25;

export type ProjectConfigResult =
	| { ok: true; config: ProjectConfig; path: string; exists: boolean; root: string }
	| { ok: false; config: ProjectConfig; path: string; error: string; root: string | null };

/** Canonicalizes only OMP's supplied cwd. It never searches ancestors or home. */
export async function resolveProjectRoot(projectRoot: string): Promise<string> {
	const root = await realpath(projectRoot);
	const info = await lstat(root);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("OMP project root must be a real directory");
	const target = resolve(root, ".huddora", "config.json");
	if (relative(root, target).startsWith("..")) throw new Error("config path escaped project root");
	return root;
}

export async function loadProjectConfig(projectRoot: string): Promise<ProjectConfigResult> {
	let root: string | null = null;
	try {
		root = await resolveProjectRoot(projectRoot);
		const directory = join(root, ".huddora");
		const path = join(directory, "config.json");
		const dirInfo = await lstat(directory).catch(error => (isMissing(error) ? null : Promise.reject(error)));
		if (!dirInfo) return { ok: true, config: { ...DEFAULT_PROJECT_CONFIG }, path, exists: false, root };
		assertPrivateDirectory(dirInfo);
		const fileInfo = await lstat(path).catch(error => (isMissing(error) ? null : Promise.reject(error)));
		if (!fileInfo) return { ok: true, config: { ...DEFAULT_PROJECT_CONFIG }, path, exists: false, root };
		assertPrivateFile(fileInfo);
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const opened = await handle.stat();
			if (opened.dev !== fileInfo.dev || opened.ino !== fileInfo.ino || !opened.isFile()) {
				throw new Error("config changed while opening");
			}
			const raw = JSON.parse(await handle.readFile("utf8")) as unknown;
			return { ok: true, config: parseProjectConfig(raw), path, exists: true, root };
		} finally {
			await handle.close();
		}
	} catch (error) {
		return {
			ok: false,
			config: { ...DEFAULT_PROJECT_CONFIG },
			path: join(projectRoot, PROJECT_CONFIG_FILENAME),
			error: message(error),
			root,
		};
	}
}

export function parseProjectConfig(value: unknown): ProjectConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config must be a JSON object");
	const object = value as Record<string, unknown>;
	for (const key of Object.keys(object)) if (!KEYS.has(key)) throw new Error(`unknown config key: ${key}`);
	if ("$schema" in object && object.$schema !== PINNED_SCHEMA) {
		throw new Error(`$schema must be ${PINNED_SCHEMA} when present`);
	}
	if (object.version !== PROJECT_CONFIG_VERSION) throw new Error(`version must be ${PROJECT_CONFIG_VERSION}`);
	const room = object.default_room_id;
	if (room !== null && (typeof room !== "string" || !UUID_RE.test(room))) {
		throw new Error("default_room_id must be a UUID or null");
	}
	return { version: 1, default_room_id: room };
}

/** Uses no-follow private files, an exclusive lock, fsync, and atomic rename under the canonical OMP root. */
export async function writeProjectConfig(projectRoot: string, config: ProjectConfig): Promise<string> {
	const checked = parseProjectConfig(config);
	const root = await resolveProjectRoot(projectRoot);
	const directory = join(root, ".huddora");
	await ensurePrivateDirectory(directory);
	const lock = await acquireLock(join(directory, ".config.lock"));
	try {
		const path = join(directory, "config.json");
		const existing = await lstat(path).catch(error => (isMissing(error) ? null : Promise.reject(error)));
		if (existing) assertPrivateFile(existing);
		const temporary = join(directory, `.config.${process.pid}.${crypto.randomUUID()}.tmp`);
		const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try {
			const created = await handle.stat();
			if (!created.isFile() || created.nlink !== 1) throw new Error("temporary config is not a private regular file");
			await handle.writeFile(`${JSON.stringify(checked, null, "\t")}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
		await syncDirectory(directory);
		return path;
	} finally {
		await lock.close().catch(() => undefined);
		await unlink(join(directory, ".config.lock")).catch(() => undefined);
	}
}

export async function setDefaultRoom(projectRoot: string, roomId: string | null): Promise<ProjectConfig> {
	if (roomId !== null && !UUID_RE.test(roomId)) throw new Error("room id must be a UUID");
	const loaded = await loadProjectConfig(projectRoot);
	if (!loaded.ok) throw new Error(loaded.error);
	const config = { ...loaded.config, default_room_id: roomId };
	await writeProjectConfig(loaded.root, config);
	return config;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	const info = await lstat(directory).catch(error => (isMissing(error) ? null : Promise.reject(error)));
	if (!info) {
		await mkdir(directory, { mode: 0o700 }).catch(async error => {
			if (!isAlreadyExists(error)) throw error;
		});
		const raced = await lstat(directory);
		assertPrivateDirectory(raced);
		await chmod(directory, 0o700);
		return;
	}
	assertPrivateDirectory(info);
}

async function acquireLock(path: string) {
	for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
		try {
			return await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
			await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}
	throw new Error("config is busy; retry the command");
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function assertPrivateDirectory(info: Awaited<ReturnType<typeof lstat>>): void {
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(".huddora must be a directory, not a symlink");
	assertOwnedAndPrivate(info, ".huddora");
}

function assertPrivateFile(info: Awaited<ReturnType<typeof lstat>>): void {
	if (info.isSymbolicLink() || !info.isFile()) throw new Error("config must be a regular file");
	assertOwnedAndPrivate(info, "config");
}

function assertOwnedAndPrivate(info: Awaited<ReturnType<typeof lstat>>, label: string): void {
	if (process.getuid && info.uid !== process.getuid()) throw new Error(`${label} is not owned by this user`);
	if ((Number(info.mode) & 0o077) !== 0) throw new Error(`${label} must not be group/world accessible`);
}

function isAlreadyExists(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
function isMissing(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const PROJECT_CONFIG_VERSION = 1;
export const PROJECT_CONFIG_FILENAME = ".huddora/config.json";

export type DeliveryPreference = "push" | "poll" | "off";
export type InjectPolicy = "active-turn-and-idle";

export type ProjectConfig = {
	version: 1;
	default_room_id: string | null;
	auto_connect: boolean;
	delivery: DeliveryPreference;
	inject: InjectPolicy;
};

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
	version: PROJECT_CONFIG_VERSION,
	default_room_id: null,
	auto_connect: true,
	delivery: "push",
	inject: "active-turn-and-idle",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = new Set(["version", "default_room_id", "auto_connect", "delivery", "inject"]);

export type ProjectConfigResult =
	| { ok: true; config: ProjectConfig; path: string; exists: boolean }
	| { ok: false; config: ProjectConfig; path: string; error: string };

/** OMP supplies ctx.cwd as the current project root; never search ancestors or home. */
export async function loadProjectConfig(projectRoot: string): Promise<ProjectConfigResult> {
	const path = join(projectRoot, PROJECT_CONFIG_FILENAME);
	try {
		await safeProjectRoot(projectRoot);
		const stat = await lstat(path).catch(error => {
			if (isMissing(error)) return null;
			throw error;
		});
		if (!stat) return { ok: true, config: { ...DEFAULT_PROJECT_CONFIG }, path, exists: false };
		if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("config must be a regular file");
		const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
		return { ok: true, config: parseProjectConfig(raw), path, exists: true };
	} catch (error) {
		return { ok: false, config: { ...DEFAULT_PROJECT_CONFIG }, path, error: message(error) };
	}
}

export function parseProjectConfig(value: unknown): ProjectConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config must be a JSON object");
	const object = value as Record<string, unknown>;
	for (const key of Object.keys(object)) if (!KEYS.has(key)) throw new Error(`unknown config key: ${key}`);
	if (object.version !== PROJECT_CONFIG_VERSION) throw new Error(`version must be ${PROJECT_CONFIG_VERSION}`);
	const room = object.default_room_id;
	if (room !== null && (typeof room !== "string" || !UUID_RE.test(room))) throw new Error("default_room_id must be a UUID or null");
	if (typeof object.auto_connect !== "boolean") throw new Error("auto_connect must be boolean");
	if (object.delivery !== "push" && object.delivery !== "poll" && object.delivery !== "off") throw new Error("delivery must be push, poll, or off");
	if (object.inject !== "active-turn-and-idle") throw new Error("inject must be active-turn-and-idle");
	return { version: 1, default_room_id: room, auto_connect: object.auto_connect, delivery: object.delivery, inject: object.inject };
}

/** Creates only <OMP cwd>/.huddora/config.json, rejects every symlink, then renames a private temporary file. */
export async function writeProjectConfig(projectRoot: string, config: ProjectConfig): Promise<string> {
	const checked = parseProjectConfig(config);
	const root = await safeProjectRoot(projectRoot);
	const directory = join(root, ".huddora");
	const dirStat = await lstat(directory).catch(error => {
		if (isMissing(error)) return null;
		throw error;
	});
	if (dirStat) {
		if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error(".huddora must be a directory, not a symlink");
	} else {
		await mkdir(directory, { mode: 0o700 }).catch(async error => {
			if (!isAlreadyExists(error)) throw error;
			const raced = await lstat(directory);
			if (raced.isSymbolicLink() || !raced.isDirectory()) throw new Error(".huddora must be a directory, not a symlink");
		});
	}
	await chmod(directory, 0o700);
	const path = join(directory, "config.json");
	const existing = await lstat(path).catch(error => {
		if (isMissing(error)) return null;
		throw error;
	});
	if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error("config must be a regular file");
	const temporary = join(directory, `.config.${process.pid}.${crypto.randomUUID()}.tmp`);
	try {
		await writeFile(temporary, `${JSON.stringify(checked, null, "\t")}\n`, { mode: 0o600, flag: "wx" });
		await chmod(temporary, 0o600);
		await rename(temporary, path);
		await chmod(path, 0o600);
		return path;
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

export async function setDefaultRoom(projectRoot: string, roomId: string | null): Promise<ProjectConfig> {
	if (roomId !== null && !UUID_RE.test(roomId)) throw new Error("room id must be a UUID");
	const loaded = await loadProjectConfig(projectRoot);
	if (!loaded.ok) throw new Error(loaded.error);
	const config = { ...loaded.config, default_room_id: roomId };
	await writeProjectConfig(projectRoot, config);
	return config;
}

async function safeProjectRoot(projectRoot: string): Promise<string> {
	const root = await realpath(projectRoot);
	const stat = await lstat(root);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("OMP project root must be a real directory");
	const target = resolve(root, ".huddora", "config.json");
	if (relative(root, target).startsWith("..")) throw new Error("config path escaped project root");
	return root;
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

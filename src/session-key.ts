/**
 * Agent seat key for agent_register.
 *
 * Product model (issue #11):
 * - Multiple OMP processes/windows = multiple agents (N seats for same human).
 * - Primary durable home is OMP branch state (`state.sessionKey`), unique per conversation/process tree.
 * - Do NOT share one install-global file across all OMP windows (that forced 1 seat thrash).
 * - Within one process: still 1 agent_id ↔ 1 live MCP bind (server exclusivity).
 *
 * Optional profile-scoped file is only used when explicitly requested (tests / advanced).
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Test override: directory that will contain seat key files. */
export const SESSION_KEY_DIR_ENV = "HUDDORA_SESSION_KEY_DIR";

const KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Active OMP/PI profile name (same source as compatibility bridge). */
export function currentOmpProfile(): string {
	const raw = (process.env.OMP_PROFILE ?? process.env.PI_PROFILE ?? "default").trim();
	return PROFILE_RE.test(raw) ? raw : "default";
}

/**
 * Optional on-disk path for a *named* seat under the profile.
 * Not the default for multi-window: shared paths collide. Prefer branch state.
 * @deprecated Prefer branch-state sessionKey; kept for tests and explicit filePath callers.
 */
export function defaultSessionKeyPath(profile = currentOmpProfile()): string {
	const override = process.env[SESSION_KEY_DIR_ENV]?.trim();
	const root = override || join(homedir(), ".config", "huddora", "seats");
	// Profile-scoped (not machine-global) — still collides for two windows on same profile
	// if used as primary; ensureSessionKey therefore prefers branch state.
	return join(root, sanitizeSegment(profile), "session_key");
}

/** Per-process instance seat file — last-resort durability only. */
export function processInstanceSessionKeyPath(
	profile = currentOmpProfile(),
	instanceId = processInstanceId(),
): string {
	const override = process.env[SESSION_KEY_DIR_ENV]?.trim();
	const root = override || join(homedir(), ".config", "huddora", "seats");
	return join(root, sanitizeSegment(profile), `instance-${sanitizeSegment(instanceId)}.key`);
}

let cachedProcessInstanceId: string | null = null;

export function processInstanceId(): string {
	// Stable for this OS process only; restarts mint a new instance id unless branch state restores the key.
	if (cachedProcessInstanceId) return cachedProcessInstanceId;
	const started = process.env.HUDDORA_PROCESS_INSTANCE_ID?.trim();
	if (started && KEY_RE.test(started)) {
		cachedProcessInstanceId = started.slice(0, 64);
		return cachedProcessInstanceId;
	}
	const material = `${process.pid}:${process.ppid ?? 0}:${randomUUID()}`;
	cachedProcessInstanceId = createHash("sha256").update(material).digest("hex").slice(0, 16);
	return cachedProcessInstanceId;
}

function sanitizeSegment(raw: string): string {
	const s = raw.trim().replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64);
	return s || "default";
}

function normalizeKey(raw: string | null | undefined): string | null {
	if (raw == null) return null;
	const key = raw.trim();
	if (!KEY_RE.test(key)) return null;
	return key;
}

async function readKeyFile(filePath: string): Promise<string | null> {
	try {
		return normalizeKey(await readFile(filePath, "utf8"));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
		return null;
	}
}

async function writeKeyFile(filePath: string, key: string): Promise<void> {
	const dir = dirname(filePath);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	try {
		await chmod(dir, 0o700);
	} catch {
		// best-effort on platforms that ignore mode
	}
	try {
		await writeFile(filePath, `${key}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
			const existing = await readKeyFile(filePath);
			if (existing) return;
			await writeFile(filePath, `${key}\n`, { encoding: "utf8", mode: 0o600 });
		} else {
			throw error;
		}
	}
	try {
		await chmod(filePath, 0o600);
	} catch {
		// best-effort
	}
}

/**
 * Resolve the seat key for this OMP process/session.
 *
 * Priority:
 * 1. `fallback` (branch state sessionKey) — per OMP conversation, survives reload
 * 2. Explicit `filePath` if provided
 * 3. Mint a new UUID (multi-OMP = multi-agent); optionally mirror to process-instance file
 *
 * Never prefers the old machine-global single file as primary (that forced one seat for all windows).
 */
export async function ensureSessionKey(opts?: {
	filePath?: string;
	fallback?: string | null;
	/** When true (default), mint/persist a process-instance file if no branch key. */
	persistInstanceFile?: boolean;
	profile?: string;
}): Promise<string> {
	const fromFallback = normalizeKey(opts?.fallback ?? null);
	if (fromFallback) return fromFallback;

	if (opts?.filePath) {
		const existing = await readKeyFile(opts.filePath);
		if (existing) return existing;
		const key = randomUUID();
		await writeKeyFile(opts.filePath, key);
		const onDisk = await readKeyFile(opts.filePath);
		return onDisk ?? key;
	}

	// Mint unique seat for this process — N OMP windows → N agents.
	const key = randomUUID();
	if (opts?.persistInstanceFile !== false) {
		const path = processInstanceSessionKeyPath(opts?.profile ?? currentOmpProfile());
		await writeKeyFile(path, key);
		const onDisk = await readKeyFile(path);
		return onDisk ?? key;
	}
	return key;
}

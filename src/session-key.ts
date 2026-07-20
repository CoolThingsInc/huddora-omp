/**
 * Agent seat key for agent_register.
 *
 * Product model:
 * - 1 user × 1 machine × 1 project → 1 agent
 * - N OMP windows on the same project root share one durable session_key
 * - Restart same project → same agent; different project/machine → different agent
 * - Seat file is LOCAL only: ~/.config/huddora/projects/<project-id>/session_key
 * - Never store session_key in git or .huddora/config.json
 * - Within one process: still 1 agent_id ↔ 1 live MCP bind (server exclusivity)
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Test override: replaces ~/.config/huddora as the seat store root. */
export const SESSION_KEY_DIR_ENV = "HUDDORA_SESSION_KEY_DIR";

const KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type EnsureSessionKeyResult = {
	key: string;
	/** True only when this call created a brand-new seat file (first bind for the project). */
	minted: boolean;
};

/** Active OMP/PI profile name (same source as plugin MCP session). */
export function currentOmpProfile(): string {
	const raw = (process.env.OMP_PROFILE ?? process.env.PI_PROFILE ?? "default").trim();
	return PROFILE_RE.test(raw) ? raw : "default";
}

/** Stable project id from canonical project root (realpath string). */
export function projectIdFromRoot(projectRoot: string): string {
	const root = projectRoot.trim();
	if (!root) return "unknown";
	return createHash("sha256").update(root).digest("hex").slice(0, 32);
}

/** Root of local huddora config (not the OMP project). */
export function huddoraConfigRoot(): string {
	const override = process.env[SESSION_KEY_DIR_ENV]?.trim();
	return override || join(homedir(), ".config", "huddora");
}

/**
 * Durable per-project seat path:
 * `~/.config/huddora/projects/<project-id>/session_key`
 */
export function projectSessionKeyPath(projectRoot: string): string {
	const id = projectIdFromRoot(projectRoot);
	return join(huddoraConfigRoot(), "projects", id, "session_key");
}

/**
 * @deprecated Use projectSessionKeyPath. Kept for older call sites/tests.
 */
export function defaultSessionKeyPath(projectRoot?: string): string {
	if (projectRoot?.trim()) return projectSessionKeyPath(projectRoot);
	return join(huddoraConfigRoot(), "projects", "unknown", "session_key");
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
 * Load-or-create the durable seat for a project.
 *
 * Priority:
 * 1. `projectRoot` seat file (shared across OMP windows / restarts)
 * 2. Explicit `filePath` (tests)
 * 3. Valid `fallback` only when no project/file path (branch cache; not preferred)
 * 4. Mint UUID (no durability)
 *
 * Concurrent windows race-safe via O_EXCL create + re-read.
 * Branch `fallback` never seeds a different project's empty file (avoids cross-project stomp).
 */
export async function ensureSessionKey(opts?: {
	projectRoot?: string | null;
	filePath?: string;
	fallback?: string | null;
	/** @deprecated ignored — process-instance seats are gone */
	persistInstanceFile?: boolean;
	/** @deprecated ignored — seats are per-project, not per-profile */
	profile?: string;
}): Promise<EnsureSessionKeyResult> {
	const projectRoot = opts?.projectRoot?.trim() || null;
	if (projectRoot) {
		return loadOrCreateKeyFile(projectSessionKeyPath(projectRoot));
	}

	if (opts?.filePath) {
		return loadOrCreateKeyFile(opts.filePath);
	}

	const fromFallback = normalizeKey(opts?.fallback ?? null);
	if (fromFallback) return { key: fromFallback, minted: false };

	return { key: randomUUID(), minted: true };
}

async function loadOrCreateKeyFile(filePath: string): Promise<EnsureSessionKeyResult> {
	const existing = await readKeyFile(filePath);
	if (existing) return { key: existing, minted: false };

	const key = randomUUID();
	await writeKeyFile(filePath, key);
	const onDisk = await readKeyFile(filePath);
	const finalKey = onDisk ?? key;
	// Another window may have won the create race — only we minted if final equals our UUID.
	return { key: finalKey, minted: finalKey === key };
}

// --- legacy helpers (tests / rare callers) ---

/** @deprecated process-instance seats removed; kept so old imports don't break mid-rollout */
export function processInstanceSessionKeyPath(
	_profile = currentOmpProfile(),
	instanceId = "legacy",
): string {
	return join(huddoraConfigRoot(), "legacy", `instance-${sanitizeSegment(instanceId)}.key`);
}

let cachedProcessInstanceId: string | null = null;

/** @deprecated */
export function processInstanceId(): string {
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

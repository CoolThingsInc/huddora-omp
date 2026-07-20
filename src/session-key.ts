/**
 * Install-local durable session_key for agent_register rebind (Telegram seat).
 * Primary: ~/.config/huddora/session_key (UUID text). Secondary: caller fallback (branch state).
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Test override: directory that will contain `session_key`. */
export const SESSION_KEY_DIR_ENV = "HUDDORA_SESSION_KEY_DIR";

const KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function defaultSessionKeyPath(): string {
	const override = process.env[SESSION_KEY_DIR_ENV]?.trim();
	if (override) return join(override, "session_key");
	return join(homedir(), ".config", "huddora", "session_key");
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
 * Mint once per install/profile; persist privately; return the same key thereafter.
 * Prefer install-local file; optional fallback (e.g. branch state) if file missing.
 */
export async function ensureSessionKey(opts?: {
	filePath?: string;
	fallback?: string | null;
}): Promise<string> {
	const filePath = opts?.filePath ?? defaultSessionKeyPath();
	const existing = await readKeyFile(filePath);
	if (existing) return existing;

	const fromFallback = normalizeKey(opts?.fallback ?? null);
	const key = fromFallback ?? randomUUID();
	await writeKeyFile(filePath, key);

	// Another process may have won the create race — prefer whoever is on disk.
	const onDisk = await readKeyFile(filePath);
	return onDisk ?? key;
}

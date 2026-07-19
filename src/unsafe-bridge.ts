import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MCP_SERVER } from "./types";

const HUDDORA_URL = "https://huddora.coolthings.fyi/mcp";
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

type Token = { access: string; expiresAt: number };
type NotificationHandler = (method: string, params: unknown) => void;

type JsonRpcResponse = { id?: number; result?: unknown; error?: { message?: string } };

export type UnsafeBridgeStatus =
	| "off"
	| "ready"
	| "expired"
	| "missing_credential"
	| "unsafe_db"
	| "unsupported"
	| "reauth_required";

export type UnsafeBridgeResult<T> = { ok: true; data: T } | { ok: false; message: string };

type BridgeOptions = { homeDir?: string };

export class UnsafeHuddoraBridge {
	#accessToken: string | null = null;
	#expiresAt = 0;
	#sessionId: string | null = null;
	#sseAbort: AbortController | null = null;
	#nextId = 1;
	#onNotification: NotificationHandler | null = null;
	#rereadAttempted = false;

	constructor(
		private readonly profile = process.env.OMP_PROFILE ?? process.env.PI_PROFILE ?? "default",
		options: BridgeOptions = {},
	) {
		this.#homeDir = options.homeDir ?? os.homedir();
	}
	#homeDir: string;

	async status(): Promise<UnsafeBridgeStatus> {
		const token = await this.#readToken();
		if (!token.ok) return token.status;
		return token.value.expiresAt > Date.now() ? "ready" : "expired";
	}

	async start(onNotification: NotificationHandler): Promise<UnsafeBridgeResult<void>> {
		this.#onNotification = onNotification;
		const token = await this.#loadToken();
		if (!token.ok) return token;
		const initialized = await this.#request("initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "huddora-omp-unsafe-bridge", version: "0.2.0" },
		});
		if (!initialized.ok) return initialized;
		await this.#notify("notifications/initialized", {});
		void this.#startSse();
		return { ok: true, data: undefined };
	}

	async callTool(toolName: string, args: Record<string, unknown>): Promise<UnsafeBridgeResult<unknown>> {
		if (!this.#sessionId) {
			const started = await this.start(this.#onNotification ?? (() => {}));
			if (!started.ok) return started;
		}
		const call = await this.#request("tools/call", { name: toolName, arguments: args });
		if (!call.ok) return call;
		return { ok: true, data: call.data };
	}

	async close(): Promise<void> {
		this.#sseAbort?.abort();
		this.#sseAbort = null;
		const token = this.#accessToken;
		const sessionId = this.#sessionId;
		this.#accessToken = null;
		this.#expiresAt = 0;
		this.#sessionId = null;
		this.#onNotification = null;
		this.#rereadAttempted = false;
		if (!token || !sessionId) return;
		try {
			await fetch(HUDDORA_URL, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId },
			});
		} catch {
			// Session termination is best effort; secrets are already dropped.
		}
	}

	async #loadToken(): Promise<UnsafeBridgeResult<void>> {
		const token = await this.#readToken();
		if (!token.ok) return { ok: false, message: unsafeStatusMessage(token.status) };
		if (token.value.expiresAt <= Date.now()) return { ok: false, message: unsafeStatusMessage("expired") };
		this.#accessToken = token.value.access;
		this.#expiresAt = token.value.expiresAt;
		return { ok: true, data: undefined };
	}

	async #request(method: string, params: Record<string, unknown>): Promise<UnsafeBridgeResult<unknown>> {
		if (!this.#accessToken || this.#expiresAt <= Date.now()) return { ok: false, message: unsafeStatusMessage("expired") };
		const id = this.#nextId++;
		try {
			const response = await fetch(HUDDORA_URL, {
				method: "POST",
				headers: this.#headers({ "Content-Type": "application/json", Accept: "application/json, text/event-stream" }),
				body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
			});
			const sessionId = response.headers.get("Mcp-Session-Id");
			if (sessionId) this.#sessionId = sessionId;
			if (response.status === 401 && !this.#rereadAttempted) {
				this.#rereadAttempted = true;
				this.#accessToken = null;
				const loaded = await this.#loadToken();
				return loaded.ok ? this.#request(method, params) : loaded;
			}
			if (response.status === 401 || response.status === 403) {
				this.#accessToken = null;
				return { ok: false, message: unsafeStatusMessage("reauth_required") };
			}
			if (!response.ok) return { ok: false, message: `Unsafe bridge HTTP ${response.status}` };
			const body = (await response.json()) as JsonRpcResponse;
			if (body.error) return { ok: false, message: "Unsafe bridge MCP tool error" };
			return { ok: true, data: body.result ?? null };
		} catch {
			return { ok: false, message: "Unsafe bridge transport error" };
		}
	}

	async #notify(method: string, params: Record<string, unknown>): Promise<void> {
		if (!this.#accessToken) return;
		try {
			await fetch(HUDDORA_URL, {
				method: "POST",
				headers: this.#headers({ "Content-Type": "application/json" }),
				body: JSON.stringify({ jsonrpc: "2.0", method, params }),
			});
		} catch {
			// The next operation will retry through normal transport handling.
		}
	}

	async #startSse(): Promise<void> {
		if (!this.#accessToken || !this.#sessionId || this.#sseAbort) return;
		const abort = new AbortController();
		this.#sseAbort = abort;
		try {
			const response = await fetch(HUDDORA_URL, {
				method: "GET",
				headers: this.#headers({ Accept: "text/event-stream" }),
				signal: abort.signal,
			});
			if (!response.ok || !response.body) return;
			const decoder = new TextDecoder();
			let buffer = "";
			for await (const chunk of response.body) {
				buffer += decoder.decode(chunk, { stream: true });
				for (;;) {
					const end = buffer.indexOf("\n\n");
					if (end < 0) break;
					const event = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const data = event
						.split("\n")
						.filter(line => line.startsWith("data:"))
						.map(line => line.slice(5).trim())
						.join("\n");
					if (!data) continue;
					try {
						const message: unknown = JSON.parse(data);
						if (!message || typeof message !== "object" || !("method" in message)) continue;
						const method = message.method;
						if (typeof method === "string") this.#onNotification?.(method, "params" in message ? message.params : undefined);
					} catch {
						// Ignore malformed events; never surface server payloads to logs.
					}
				}
			}
		} catch {
			// Polling remains active; no retry loop is started after explicit close.
		} finally {
			if (this.#sseAbort === abort) this.#sseAbort = null;
		}
	}

	#headers(base: Record<string, string>): Record<string, string> {
		const headers: Record<string, string> = { ...base, Authorization: `Bearer ${this.#accessToken ?? ""}` };
		if (this.#sessionId) headers["Mcp-Session-Id"] = this.#sessionId;
		return headers;
	}

	async #readToken(): Promise<{ ok: true; value: Token } | { ok: false; status: UnsafeBridgeStatus }> {
		if (process.platform === "win32" || !PROFILE_NAME.test(this.profile)) return { ok: false, status: "unsupported" };
		const root = path.join(this.#homeDir, ".omp");
		const expectedRoot =
			this.profile === "default"
				? path.join(root, "agent")
				: path.join(root, "profiles", this.profile, "agent");
		const dbPath = path.join(expectedRoot, "agent.db");
		try {
			const [dir, db] = await Promise.all([fs.lstat(expectedRoot), fs.lstat(dbPath)]);
			if (!dir.isDirectory() || dir.isSymbolicLink() || !db.isFile() || db.isSymbolicLink()) {
				return { ok: false, status: "unsafe_db" };
			}
			if ((dir.mode & 0o022) !== 0 || (db.mode & 0o022) !== 0 || (typeof process.getuid === "function" && db.uid !== process.getuid())) {
				return { ok: false, status: "unsafe_db" };
			}
			const [realRoot, realDb] = await Promise.all([fs.realpath(expectedRoot), fs.realpath(dbPath)]);
			if (!realDb.startsWith(`${realRoot}${path.sep}`)) return { ok: false, status: "unsafe_db" };
			const dbHandle = new Database(realDb, { readonly: true });
			try {
				const columns = dbHandle.query("PRAGMA table_info(auth_credentials)").all();
				if (!hasCredentialSchema(columns)) return { ok: false, status: "unsupported" };
				const provider = `mcp_oauth:profile:${this.profile}:${HUDDORA_URL}`;
				const row = dbHandle
					.query(
						"SELECT json_extract(data, '$.access') AS access, json_extract(data, '$.expires') AS expires_ms FROM auth_credentials WHERE provider = ?1 AND credential_type = 'oauth' AND disabled_cause IS NULL ORDER BY id ASC LIMIT 1",
					)
					.get(provider);
				if (!isTokenRow(row)) return { ok: false, status: "missing_credential" };
				return { ok: true, value: { access: row.access, expiresAt: row.expires_ms } };
			} finally {
				dbHandle.close();
			}
		} catch {
			return { ok: false, status: "missing_credential" };
		}
	}
}

function hasCredentialSchema(value: unknown): boolean {
	if (!Array.isArray(value)) return false;
	const names = new Set<string>();
	for (const column of value) {
		if (column && typeof column === "object" && "name" in column && typeof column.name === "string") {
			names.add(column.name);
		}
	}
	return names.has("provider") && names.has("credential_type") && names.has("data") && names.has("disabled_cause");
}

function isTokenRow(value: unknown): value is { access: string; expires_ms: number } {
	if (!value || typeof value !== "object" || !("access" in value) || !("expires_ms" in value)) return false;
	return typeof value.access === "string" && value.access.length > 0 && typeof value.expires_ms === "number" && Number.isFinite(value.expires_ms);
}

export function unsafeStatusMessage(status: UnsafeBridgeStatus): string {
	switch (status) {
		case "expired":
		case "reauth_required":
			return "Compatibility bridge needs fresh Huddora OAuth. Run /mcp reauth huddora.";
		case "missing_credential":
			return "Compatibility bridge found no active Huddora OAuth credential for this profile.";
		case "unsafe_db":
			return "Compatibility bridge refused this profile database because its path or permissions are unsafe.";
		case "unsupported":
			return "Compatibility bridge is unsupported for this runtime/profile path.";
		default:
			return "Compatibility bridge is off.";
	}
}

export { HUDDORA_URL, MCP_SERVER };

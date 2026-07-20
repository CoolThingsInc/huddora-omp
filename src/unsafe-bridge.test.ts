import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { UnsafeHuddoraBridge } from "./unsafe-bridge";

const roots: string[] = [];
const URL = "https://huddora.coolthings.fyi/mcp";

async function fixture(profile = "default", schema = true): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "huddora-bridge-"));
	roots.push(root);
	const agent = profile === "default" ? path.join(root, ".omp", "agent") : path.join(root, ".omp", "profiles", profile, "agent");
	await fs.mkdir(agent, { recursive: true, mode: 0o700 });
	const db = new Database(path.join(agent, "agent.db"));
	if (schema) {
		db.run("CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT)");
	}
	db.close();
	await fs.chmod(agent, 0o700);
	await fs.chmod(path.join(agent, "agent.db"), 0o600);
	return root;
}

async function addRow(root: string, profile: string, expires: number, disabledCause: string | null = null): Promise<void> {
	const agent = profile === "default" ? path.join(root, ".omp", "agent") : path.join(root, ".omp", "profiles", profile, "agent");
	const db = new Database(path.join(agent, "agent.db"));
	db.run(
		"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause) VALUES (?, 'oauth', ?, ?)",
		[`mcp_oauth:profile:${profile}:${URL}`, JSON.stringify({ access: "fixture-access", refresh: "must-not-leak", expires, clientSecret: "must-not-leak" }), disabledCause],
	);
	db.close();
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("compatibility bridge credential boundary", () => {
	test("reads only a valid active-profile credential projection", async () => {
		const root = await fixture("work");
		await addRow(root, "work", Date.now() + 60_000);
		const bridge = new UnsafeHuddoraBridge("work", { homeDir: root });
		expect(await bridge.status()).toBe("ready");
	});

	test("does not use a credential from another profile", async () => {
		const root = await fixture("work");
		await addRow(root, "work", Date.now() + 60_000);
		const personal = await fixture("personal");
		await addRow(personal, "personal", Date.now() + 60_000);
		const bridge = new UnsafeHuddoraBridge("personal", { homeDir: root });
		expect(await bridge.status()).toBe("missing_credential");
	});

	test("fails closed for expiry, disabled rows, malformed credential JSON, and unsupported schema", async () => {
		const expired = await fixture();
		await addRow(expired, "default", Date.now() - 1);
		expect(await new UnsafeHuddoraBridge("default", { homeDir: expired }).status()).toBe("expired");

		const disabled = await fixture();
		await addRow(disabled, "default", Date.now() + 60_000, "disabled");
		expect(await new UnsafeHuddoraBridge("default", { homeDir: disabled }).status()).toBe("missing_credential");

		const malformed = await fixture();
		const db = new Database(path.join(malformed, ".omp", "agent", "agent.db"));
		db.run("INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause) VALUES (?, 'oauth', ?, NULL)", [
			`mcp_oauth:profile:default:${URL}`,
			"not-json",
		]);
		db.close();
		expect(await new UnsafeHuddoraBridge("default", { homeDir: malformed }).status()).toBe("missing_credential");

		const unsupported = await fixture("default", false);
		expect(await new UnsafeHuddoraBridge("default", { homeDir: unsupported }).status()).toBe("unsupported");
	});

	test("rereads once after 401 and never exposes the fixture token in errors", async () => {
		const root = await fixture();
		await addRow(root, "default", Date.now() + 60_000);
		const fetchSpy = spyOn(globalThis, "fetch");
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
				status: 200,
				headers: { "Mcp-Session-Id": "fixture-session" },
			}),
		);
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 202 }));
		fetchSpy.mockResolvedValueOnce(new Response("fixture-access", { status: 401 }));
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [] } }), { status: 200 }),
		);
		const bridge = new UnsafeHuddoraBridge("default", { homeDir: root });
		const started = await bridge.start(() => {});
		expect(started).toEqual({ ok: true, data: undefined });
		const result = await bridge.callTool("room_list", {});
		expect(result.ok).toBe(true);
		for (const call of fetchSpy.mock.calls) {
			const options = call[1];
			if (options && typeof options === "object" && "body" in options) {
				expect(String(options.body)).not.toContain("fixture-access");
			}
		}
		fetchSpy.mockRestore();
	});

	test("unwraps JSON MCP text content for bridge callers", async () => {
		const root = await fixture();
		await addRow(root, "default", Date.now() + 60_000);
		const fetchSpy = spyOn(globalThis, "fetch");
		fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "Mcp-Session-Id": "fixture-session" } }));
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 202 }));
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: '{"rooms":[]}' }] } }), { status: 200 }),
		);
		const bridge = new UnsafeHuddoraBridge("default", { homeDir: root });
		expect((await bridge.start(() => {})).ok).toBe(true);
		expect(await bridge.callTool("room_list", {})).toEqual({ ok: true, data: { rooms: [] } });
		fetchSpy.mockRestore();
	});

	test("surfaces tools/call isError text as ok:false message", async () => {
		const root = await fixture();
		await addRow(root, "default", Date.now() + 60_000);
		const fetchSpy = spyOn(globalThis, "fetch");
		fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "Mcp-Session-Id": "fixture-session" } }));
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 202 }));
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 2,
					result: {
						isError: true,
						content: [{ type: "text", text: "agent_not_bound — call agent_register first" }],
					},
				}),
				{ status: 200 },
			),
		);
		const bridge = new UnsafeHuddoraBridge("default", { homeDir: root });
		expect((await bridge.start(() => {})).ok).toBe(true);
		const res = await bridge.callTool("agent_heartbeat", {});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.message).toContain("agent_not_bound");
		fetchSpy.mockRestore();
	});

	test("rereads once for each independent 401 request", async () => {
		const root = await fixture();
		await addRow(root, "default", Date.now() + 60_000);
		const fetchSpy = spyOn(globalThis, "fetch");
		fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "Mcp-Session-Id": "fixture-session" } }));
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 202 }));
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }));
		fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }), { status: 200 }));
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }));
		fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 3, result: {} }), { status: 200 }));
		const bridge = new UnsafeHuddoraBridge("default", { homeDir: root });
		expect((await bridge.start(() => {})).ok).toBe(true);
		expect((await bridge.callTool("room_list", {})).ok).toBe(true);
		expect((await bridge.callTool("room_list", {})).ok).toBe(true);
		fetchSpy.mockRestore();
	});

	test("rereads before a request when its cached expiry elapses", async () => {
		const root = await fixture();
		await addRow(root, "default", Date.now() + 50);
		const fetchSpy = spyOn(globalThis, "fetch");
		fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "Mcp-Session-Id": "fixture-session" } }));
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 202 }));
		const bridge = new UnsafeHuddoraBridge("default", { homeDir: root });
		expect((await bridge.start(() => {})).ok).toBe(true);
		await new Promise(resolve => setTimeout(resolve, 60));
		const db = new Database(path.join(root, ".omp", "agent", "agent.db"));
		db.run("UPDATE auth_credentials SET data = ?", [JSON.stringify({ access: "fixture-access", expires: Date.now() + 60_000 })]);
		db.close();
		fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }), { status: 200 }));
		expect((await bridge.callTool("room_list", {})).ok).toBe(true);
		fetchSpy.mockRestore();
	});

	test("recovers the first SSE 401, rejects the second, and redacts fixture access", async () => {
		const root = await fixture();
		await addRow(root, "default", Date.now() + 60_000);
		const scheduled: Array<() => Promise<void>> = [];
		const fetchSpy = spyOn(globalThis, "fetch");
		fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "Mcp-Session-Id": "fixture-session" } }));
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 202 }));
		const bridge = new UnsafeHuddoraBridge("default", {
			homeDir: root,
			schedule: run => {
				scheduled.push(run as () => Promise<void>);
				return run;
			},
			cancelSchedule: () => {},
		});
		expect((await bridge.start(() => {})).ok).toBe(true);
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }));
		fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }), { status: 200, headers: { "Mcp-Session-Id": "replacement-session" } }));
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 202 }));
		await scheduled[0]!();
		expect(scheduled).toHaveLength(2);
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }));
		await scheduled[1]!();
		expect(await bridge.status()).toBe("reauth_required");
		for (const [url, options] of fetchSpy.mock.calls) {
			expect(String(url)).not.toContain("fixture-access");
			expect(String(options?.body ?? "")).not.toContain("fixture-access");
		}
		fetchSpy.mockRestore();
	});

	test("delivers validated SSE notifications to the supplied handler", async () => {
		const root = await fixture();
		await addRow(root, "default", Date.now() + 60_000);
		const scheduled: Array<() => Promise<void>> = [];
		const received: Array<[string, unknown]> = [];
		const fetchSpy = spyOn(globalThis, "fetch");
		fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "Mcp-Session-Id": "fixture-session" } }));
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 202 }));
		fetchSpy.mockResolvedValueOnce(new Response('data: {"method":"notifications/huddora/messages","params":{"room_id":"r"}}\n\n', { status: 200 }));
		const bridge = new UnsafeHuddoraBridge("default", {
			homeDir: root,
			schedule: run => {
				scheduled.push(run as () => Promise<void>);
				return run;
			},
			cancelSchedule: () => {},
		});
		expect((await bridge.start((method, params) => received.push([method, params]))).ok).toBe(true);
		await scheduled[0]!();
		expect(received).toEqual([["notifications/huddora/messages", { room_id: "r" }]]);
		fetchSpy.mockRestore();
	});

	test("backs off SSE reconnects exponentially and cancels on close", async () => {
		const root = await fixture();
		await addRow(root, "default", Date.now() + 60_000);
		const scheduled: Array<{ run: () => Promise<void>; delay: number; cancelled: boolean }> = [];
		const fetchSpy = spyOn(globalThis, "fetch");
		fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "Mcp-Session-Id": "fixture-session" } }));
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 202 }));
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 503 }));
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 503 }));
		const bridge = new UnsafeHuddoraBridge("default", {
			homeDir: root,
			schedule: (run, delay) => {
				const task = { run: run as () => Promise<void>, delay, cancelled: false };
				scheduled.push(task);
				return task;
			},
			cancelSchedule: handle => {
				(handle as { cancelled: boolean }).cancelled = true;
			},
		});
		expect((await bridge.start(() => {})).ok).toBe(true);
		expect(scheduled.map(task => task.delay)).toEqual([100]);
		await scheduled[0]!.run();
		expect(scheduled.map(task => task.delay)).toEqual([100, 1_000]);
		await scheduled[1]!.run();
		expect(scheduled.map(task => task.delay)).toEqual([100, 1_000, 2_000]);
		await bridge.close();
		expect(scheduled[2]!.cancelled).toBe(true);
		fetchSpy.mockRestore();
	});





	test("closes its session with the token only in an Authorization header", async () => {
		const root = await fixture();
		await addRow(root, "default", Date.now() + 60_000);
		const fetchSpy = spyOn(globalThis, "fetch");
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
				status: 200,
				headers: { "Mcp-Session-Id": "fixture-session" },
			}),
		);
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 202 }));
		const bridge = new UnsafeHuddoraBridge("default", { homeDir: root });
		expect((await bridge.start(() => {})).ok).toBe(true);
		await bridge.close();
		const close = fetchSpy.mock.calls.find(([, options]) => (options as RequestInit | undefined)?.method === "DELETE");
		expect(close?.[1]).toMatchObject({ method: "DELETE", headers: { "Mcp-Session-Id": "fixture-session" } });
		expect(String(close?.[1]?.body ?? "")).not.toContain("fixture-access");
		fetchSpy.mockRestore();
	});
	test("rejects a symlink, writable database, or unsafe ancestor path", async () => {
		const symlinkRoot = await fixture();
		const agent = path.join(symlinkRoot, ".omp", "agent");
		const target = path.join(symlinkRoot, "target.db");
		await fs.rename(path.join(agent, "agent.db"), target);
		await fs.symlink(target, path.join(agent, "agent.db"));
		expect(await new UnsafeHuddoraBridge("default", { homeDir: symlinkRoot }).status()).toBe("unsafe_db");

		const writableRoot = await fixture();
		await fs.chmod(path.join(writableRoot, ".omp", "agent", "agent.db"), 0o622);
		expect(await new UnsafeHuddoraBridge("default", { homeDir: writableRoot }).status()).toBe("unsafe_db");

		const unsafeAncestor = await fixture();
		await fs.chmod(path.join(unsafeAncestor, ".omp"), 0o722);
		expect(await new UnsafeHuddoraBridge("default", { homeDir: unsafeAncestor }).status()).toBe("unsafe_db");
	});
});

import { describe, expect, test } from "bun:test";
import {
	commandDescription,
	defaultMenuAction,
	deriveMenuActions,
	HUDDORA_COMMANDS,
	HUDDORA_COMMAND_NAMES,
	type MenuAction,
	type MenuState,
} from "./commands";

const ALL_COMMAND_NAMES = [
	"init",
	"config",
	"room",
	"help",
	"status",
	"doctor",
	"connect",
	"push",
	"pause",
	"resume",
	"sync",
	"disconnect",
] as const;

function ids(actions: readonly MenuAction[]): MenuAction["id"][] {
	return actions.map((a) => a.id);
}

function online(roomId: string | null = "r1", over: Partial<MenuState> = {}): MenuState {
	return { roomId, connection: "bridge", paused: false, lastError: null, ...over };
}

describe("command registry", () => {
	test("HUDDORA_COMMANDS lists every runtime command exactly once", () => {
		const names = HUDDORA_COMMANDS.map((c) => c.name);
		// Every known command present...
		for (const name of ALL_COMMAND_NAMES) {
			expect(names).toContain(name);
		}
		// ...exactly once (no duplicates, no extras).
		expect(new Set(names).size).toBe(names.length);
		expect(names.length).toBe(ALL_COMMAND_NAMES.length);
	});

	test("HUDDORA_COMMAND_NAMES manifest entries are exact `/huddora <name>`", () => {
		const expected = ALL_COMMAND_NAMES.map((n) => `/huddora ${n}`);
		expect([...HUDDORA_COMMAND_NAMES]).toEqual(expected);
	});

	test("HUDDORA_COMMAND_NAMES length and order match HUDDORA_COMMANDS", () => {
		expect(HUDDORA_COMMAND_NAMES.length).toBe(HUDDORA_COMMANDS.length);
		for (let i = 0; i < HUDDORA_COMMANDS.length; i++) {
			expect(HUDDORA_COMMAND_NAMES[i]).toBe(`/huddora ${HUDDORA_COMMANDS[i]!.name}`);
		}
	});

	test("commandDescription is the bar-delimited surface string", () => {
		expect(commandDescription()).toBe(
			`Huddora: ${ALL_COMMAND_NAMES.join("|")}`,
		);
	});

	test("every command has a non-empty description and a boolean hiddenFromMenu", () => {
		for (const c of HUDDORA_COMMANDS) {
			expect(typeof c.description).toBe("string");
			expect(c.description.length).toBeGreaterThan(0);
			expect(typeof c.hiddenFromMenu).toBe("boolean");
		}
	});

	test("push is hidden from menu; fundamental commands are not", () => {
		const push = HUDDORA_COMMANDS.find((c) => c.name === "push");
		expect(push?.hiddenFromMenu).toBe(true);
		for (const fundamental of ["status", "doctor", "room", "connect"] as const) {
			const c = HUDDORA_COMMANDS.find((m) => m.name === fundamental);
			expect(c?.hiddenFromMenu).toBe(false);
		}
	});
});

describe("human-facing string hygiene", () => {
	// Dead command removed from the extension; must not surface anywhere.
	test("no command name or description mentions the dead /huddora bridge command", () => {
		for (const c of HUDDORA_COMMANDS) {
			expect(c.name).not.toContain("bridge");
			expect(c.description).not.toContain("/huddora bridge");
		}
		for (const n of HUDDORA_COMMAND_NAMES) {
			expect(n).not.toBe("/huddora bridge");
		}
	});

	// Forbidden transport jargon must not leak into human-visible descriptions.
	const FORBIDDEN_JARGON = /bridge SSE|room_watch|manual poll|poll only|out of band|\bSSE\b/i;
	test("command descriptions avoid forbidden transport jargon", () => {
		for (const c of HUDDORA_COMMANDS) {
			expect(FORBIDDEN_JARGON.test(c.description)).toBe(false);
		}
	});

	test("menu action descriptions avoid forbidden transport jargon", () => {
		const states: MenuState[] = [
			{ roomId: null, connection: "bridge_missing", paused: false, lastError: null },
			online(null),
			online(),
			online("r1", { paused: true }),
			{ roomId: "r1", connection: "no_host_api", paused: false, lastError: "401 unauthorized" },
			{ roomId: "r1", connection: "bridge_missing", paused: false, lastError: "boom" },
		];
		for (const s of states) {
			for (const a of deriveMenuActions(s)) {
				expect(FORBIDDEN_JARGON.test(a.description)).toBe(false);
				expect(a.description).not.toContain("/huddora bridge");
			}
		}
	});

	test("rewritten command descriptions are human-readable", () => {
		const want: Record<string, RegExp> = {
			doctor: /diagnostics/i,
			connect: /reconnect/i,
			push: /live updates/i,
			pause: /pause room updates/i,
			resume: /resume room updates/i,
			sync: /check for new room messages/i,
		};
		for (const [name, re] of Object.entries(want)) {
			const c = HUDDORA_COMMANDS.find((m) => m.name === name);
			expect(c).toBeDefined();
			expect(re.test(c!.description)).toBe(true);
		}
	});
});

describe("deriveMenuActions", () => {
	test("no-room menu never offers sync/pause/disconnect", () => {
		const offline = deriveMenuActions({
			roomId: null,
			connection: "bridge_missing",
			paused: false,
			lastError: null,
		});
		const onlineNoRoom = deriveMenuActions(online(null));
		for (const menu of [offline, onlineNoRoom]) {
			const present = ids(menu);
			expect(present).not.toContain("sync");
			expect(present).not.toContain("pause");
			expect(present).not.toContain("resume");
			expect(present).not.toContain("disconnect");
		}
		// No-room menu always offers a path forward.
		expect(ids(offline)).toContain("pick_room");
	});

	test("no-room menu offers setup/status/help", () => {
		const menu = deriveMenuActions({
			roomId: null,
			connection: "bridge_missing",
			paused: false,
			lastError: null,
		});
		expect(ids(menu)).toContain("setup");
		expect(ids(menu)).toContain("status");
		expect(ids(menu)).toContain("help");
	});

	test("healthy bound menu offers sync and pause (not resume)", () => {
		const menu = deriveMenuActions(online());
		expect(ids(menu)).toContain("sync");
		expect(ids(menu)).toContain("pause");
		expect(ids(menu)).not.toContain("resume");
	});

	test("paused menu offers resume (not pause)", () => {
		const menu = deriveMenuActions(online("r1", { paused: true }));
		expect(ids(menu)).toContain("resume");
		expect(ids(menu)).not.toContain("pause");
		// sync is still a valid manual action when paused.
		expect(ids(menu)).not.toContain("sync");
	});

	test("OAuth failure menu offers reauth (no room)", () => {
		const menu = deriveMenuActions({
			roomId: null,
			connection: "bridge_missing",
			paused: false,
			lastError: "OAuth token expired: 401 Unauthorized",
		});
		expect(ids(menu)).toContain("reauth");
		expect(ids(menu)).toContain("status");
	});

	test("OAuth failure menu offers reauth + reconnect (room bound, offline)", () => {
		const menu = deriveMenuActions({
			roomId: "r1",
			connection: "no_host_api",
			paused: false,
			lastError: "credential missing — reauth required",
		});
		expect(ids(menu)).toContain("reauth");
		expect(ids(menu)).toContain("reconnect");
		expect(ids(menu)).toContain("doctor");
		// Not online: no sync/pause/operational actions.
		expect(ids(menu)).not.toContain("sync");
		expect(ids(menu)).not.toContain("pause");
	});

	test("offline non-OAuth room offers reconnect and doctor, not reauth", () => {
		const menu = deriveMenuActions({
			roomId: "r1",
			connection: "bridge_missing",
			paused: false,
			lastError: "transport reset",
		});
		expect(ids(menu)).toContain("reconnect");
		expect(ids(menu)).toContain("doctor");
		expect(ids(menu)).not.toContain("reauth");
	});

	test("online disconnect action is clearly marked destructive and last", () => {
		const menu = deriveMenuActions(online());
		const disc = menu.find((a) => a.id === "disconnect");
		expect(disc).toBeDefined();
		expect(disc?.destructive).toBe(true);
		// Disconnect must not be the default (first) action.
		expect(menu[0]!.id).not.toBe("disconnect");
	});

	test("menus contain 3–5 actions", () => {
		const states: MenuState[] = [
			{ roomId: null, connection: "bridge_missing", paused: false, lastError: null },
			online(null),
			online(),
			online("r1", { paused: true }),
			{ roomId: "r1", connection: "no_host_api", paused: false, lastError: "401 unauthorized" },
			{ roomId: "r1", connection: "bridge_missing", paused: false, lastError: "boom" },
		];
		for (const s of states) {
			const menu = deriveMenuActions(s);
			expect(menu.length).toBeGreaterThanOrEqual(3);
			expect(menu.length).toBeLessThanOrEqual(5);
		}
	});

	test("action ids are stable and unique within a menu", () => {
		const states: MenuState[] = [
			{ roomId: null, connection: "bridge_missing", paused: false, lastError: null },
			online(),
			online("r1", { paused: true }),
			{ roomId: "r1", connection: "no_host_api", paused: false, lastError: "oauth expired 401" },
		];
		for (const s of states) {
			const menuIds = ids(deriveMenuActions(s));
			expect(new Set(menuIds).size).toBe(menuIds.length);
		}
	});
});

describe("defaultMenuAction", () => {
	test("no-room offline defaults to pick_room", () => {
		const id = defaultMenuAction({
			roomId: null,
			connection: "bridge_missing",
			paused: false,
			lastError: null,
		});
		expect(id).toBe("pick_room");
	});

	test("healthy bound defaults to sync", () => {
		expect(defaultMenuAction(online())).toBe("sync");
	});

	test("paused defaults to resume", () => {
		expect(defaultMenuAction(online("r1", { paused: true }))).toBe("resume");
	});

	test("offline OAuth defaults to reauth", () => {
		expect(
			defaultMenuAction({
				roomId: "r1",
				connection: "no_host_api",
				paused: false,
				lastError: "OAuth token expired: 401",
			}),
		).toBe("reauth");
	});

	test("default action is always present in the returned menu", () => {
		const states: MenuState[] = [
			{ roomId: null, connection: "bridge_missing", paused: false, lastError: null },
			online(null),
			online(),
			online("r1", { paused: true }),
			{ roomId: null, connection: "bridge_missing", paused: false, lastError: "reauth needed 401" },
			{ roomId: "r1", connection: "bridge_missing", paused: false, lastError: "transient" },
		];
		for (const s of states) {
			const menu = deriveMenuActions(s);
			const def = defaultMenuAction(s);
			expect(ids(menu)).toContain(def);
			// Default is never the destructive disconnect.
			expect(def).not.toBe("disconnect");
		}
	});
});

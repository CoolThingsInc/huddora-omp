import { describe, expect, test } from "bun:test";
import { PREEMPTED_STATUS_MESSAGE } from "./agent-bind";
import { HUDDORA_GLYPH } from "./brand";
import {
	derivePresence,
	formatStatusLine,
	formatStatusReport,
	formatStatusWidgetLines,
	presenceThemeColor,
	STATUS_KEY,
	type StatusTheme,
} from "./status-surface";

const base = {
	pluginVersion: "0.3.17",
	agentDisplayName: "Alice's OMP",
	selfAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	roomId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	roomName: "Slupport",
	presence: "online" as const,
	delivery: "bridge",
	paused: false,
	bridgeActive: true,
	connection: "bridge",
	lastError: null,
};

const plainTheme: StatusTheme = {
	fg: (_color, text) => text,
};

describe("status surface facade", () => {
	test("STATUS_KEY is stable for setStatus", () => {
		expect(STATUS_KEY).toBe("huddora");
	});

	describe("derivePresence matrix", () => {
		test("needs_setup when no agent seat", () => {
			expect(
				derivePresence({
					selfAgentId: null,
					lastError: null,
					heartbeatOk: false,
					bridgeReady: false,
				}),
			).toBe("needs_setup");
		});

		test("online when seat + heartbeat + bridge all green", () => {
			expect(
				derivePresence({
					selfAgentId: "a",
					lastError: null,
					heartbeatOk: true,
					bridgeReady: true,
				}),
			).toBe("online");
		});

		test("needs_setup on rebind / preempt / unbound signals", () => {
			expect(
				derivePresence({
					selfAgentId: "a",
					lastError: "presence rebind pending",
					heartbeatOk: false,
					bridgeReady: true,
				}),
			).toBe("needs_setup");
			expect(
				derivePresence({
					selfAgentId: "a",
					lastError: PREEMPTED_STATUS_MESSAGE,
					heartbeatOk: false,
					bridgeReady: true,
				}),
			).toBe("needs_setup");
			expect(
				derivePresence({
					selfAgentId: "a",
					lastError: "agent_not_bound",
					heartbeatOk: false,
					bridgeReady: false,
				}),
			).toBe("needs_setup");
			expect(
				derivePresence({
					selfAgentId: "a",
					lastError: "seat taken",
					heartbeatOk: false,
					bridgeReady: true,
				}),
			).toBe("needs_setup");
		});

		test("revoked when lastError mentions revoke", () => {
			expect(
				derivePresence({
					selfAgentId: "a",
					lastError: "agent revoked — open /account/agents",
					heartbeatOk: false,
					bridgeReady: true,
				}),
			).toBe("revoked");
		});

		test("offline when seat exists, heartbeat up, but bridge down", () => {
			expect(
				derivePresence({
					selfAgentId: "a",
					lastError: null,
					heartbeatOk: true,
					bridgeReady: false,
				}),
			).toBe("offline");
		});
	});

	describe("presenceThemeColor", () => {
		test("maps each presence to a theme role", () => {
			expect(presenceThemeColor("online")).toBe("success");
			expect(presenceThemeColor("offline")).toBe("warning");
			expect(presenceThemeColor("revoked")).toBe("error");
			expect(presenceThemeColor("needs_setup")).toBe("dim");
		});
	});

	describe("formatStatusLine (ANSI-free compact fallback)", () => {
		test("glanceable single line, no ANSI, brand + state + room · agent", () => {
			const line = formatStatusLine(base);
			expect(line).toBe(
			`${HUDDORA_GLYPH} Huddora v0.3.17 — Ready  ${base.roomName} · ${base.agentDisplayName}`,
			);
			// never multiline
			expect(line.split("\n")).toHaveLength(1);
			// never carries ANSI
			expect(line).not.toMatch(/\x1b/);
		});

		test("accepts a theme but does not apply it (OMP setStatus strips ANSI)", () => {
			const applied: string[] = [];
			const theme: StatusTheme = {
				fg: (color, text) => {
					applied.push(color);
					return `[${color}]${text}`;
				},
			};
			const line = formatStatusLine(base, theme);
			// theme callback never invoked — status stays plain
			expect(applied).toEqual([]);
			expect(line).not.toMatch(/\[/); // no [color] tags
			expect(line).toBe(formatStatusLine(base, plainTheme));
		});

		test("no room degrades room label to 'no room'", () => {
			const line = formatStatusLine({ ...base, roomId: null, roomName: null });
			expect(line).toContain("no room");
			expect(line).not.toContain(base.roomName as string);
		});

		test("paused appends the paused marker", () => {
			const line = formatStatusLine({ ...base, paused: true });
			expect(line).toContain("paused");
		});

		test("unregistered agent shows 'unregistered agent'", () => {
			const line = formatStatusLine({
				...base,
				agentDisplayName: null,
				selfAgentId: null,
				presence: "needs_setup",
			});
			expect(line).toContain("unregistered agent");
		});
	});

	describe("formatStatusWidgetLines (2–3 themed widget lines)", () => {
		test("ready state produces exactly 2 lines", () => {
			const lines = formatStatusWidgetLines(base, plainTheme);
			expect(lines).toHaveLength(2);
			expect(lines[0]).toBe(`${HUDDORA_GLYPH} Huddora v0.3.17 — Ready`);
			expect(lines[1]).toBe("Slupport · Alice's OMP");
		});

		test("non-ready state produces exactly 3 lines with a next action", () => {
			const lines = formatStatusWidgetLines(
				{ ...base, lastError: "seat taken — preempted" },
				plainTheme,
			);
			expect(lines).toHaveLength(3);
			expect(lines[2]).toBe("run /huddora connect");
		});

		test("no-room (setup) yields 3 lines and a room-setup next action", () => {
			const lines = formatStatusWidgetLines(
				{ ...base, roomId: null, roomName: null, presence: "offline" as const },
				plainTheme,
			);
			expect(lines).toHaveLength(3);
			expect(lines[1]).toBe("no room · Alice's OMP");
			expect(lines[2]).toBe("create or join a room, then /huddora room");
		});

		test("theme colors the brand/state and next line by model color, context muted", () => {
			const tags: string[] = [];
			const theme: StatusTheme = {
				fg: (color, text) => {
					tags.push(color);
					return `[${color}]${text}`;
				},
			};
			const lines = formatStatusWidgetLines(
				{ ...base, lastError: "seat taken — preempted" },
				theme,
			);
			// reconnect → warning: brand/state line colored, context muted, next warning
			expect(lines).toHaveLength(3);
			expect(lines[0]).toContain("[warning]");
			expect(lines[1]).toContain("[muted]");
			expect(lines[2]).toContain("[warning]");
			expect(tags).toEqual(["warning", "muted", "warning"]);
		});

		test("ready themed widget only emits two color calls (brand + context)", () => {
			const tags: string[] = [];
			const theme: StatusTheme = {
				fg: (color, text) => {
					tags.push(color);
					return text;
				},
			};
			formatStatusWidgetLines(base, theme);
			expect(tags).toEqual(["success", "muted"]);
		});
	});

	describe("formatStatusReport (clean lobby report)", () => {
		test("bound online room renders the full room_id on its own line", () => {
			const report = formatStatusReport(base);
			const lines = report.split("\n");
			expect(lines).toContain(base.roomId);
			// full room_id appears verbatim, un-truncated
			expect(report).toContain("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
			expect(report).not.toContain("bbbbbbbb…");
		});

		test("contains exactly one Next line", () => {
			const report = formatStatusReport(base);
			const nextLines = report.split("\n").filter((l) => l.startsWith("Next:"));
			expect(nextLines).toHaveLength(1);
		});

		test("healthy report Next is a short ready line, no raw nextDueAt", () => {
			const report = formatStatusReport(base);
			expect(report).toContain("Next: ready");
			expect(report).not.toContain("nextDueAt");
		});

		test("no-room report routes Next to room setup guidance", () => {
			const report = formatStatusReport({
				...base,
				roomId: null,
				roomName: null,
				selfAgentId: null,
			});
			expect(report).toContain("Next:");
			expect(report).toMatch(/No room bound|huddora\.coolthings\.fyi/);
			expect(report).toContain("Room: none");
		});

		test("needs_setup with preempted seat routes Next to connect", () => {
			const report = formatStatusReport({
				...base,
				presence: "needs_setup",
				lastError: PREEMPTED_STATUS_MESSAGE,
				connection: "unknown",
			});
			expect(report).toContain("Next:");
			expect(report).toMatch(/connect/i);
		});

		test("never leaks forbidden operator/model jargon across all states", () => {
			const forbidden = [
				"bridge",
				"courier-primary",
				"courier_primary",
				"lease_ttl",
				"lease=",
				"seat stamp",
				"last seat stamp",
				"MCPManager",
				"mute-trap",
				"mute_trap",
				"xd://",
				"session_key",
				"room_snapshot",
				"room_list",
				"agent_not_bound",
				"agent_preempted",
				"bound_elsewhere",
				"extension_version",
				"Bus:",
				"light=",
			];
			const cases = [
				base,
				{ ...base, roomId: null, roomName: null, selfAgentId: null, presence: "needs_setup" as const },
				{ ...base, presence: "revoked" as const, lastError: "revoked" },
				{ ...base, lastError: "401 Unauthorized: reauth required" },
				{ ...base, lastError: PREEMPTED_STATUS_MESSAGE },
				{ ...base, presence: "offline" as const, connection: "disconnected" },
				{ ...base, courierPrimary: true, leaseExpiresAt: Date.now() + 90_000, deliveryLight: "green" },
				{ ...base, seatExclusive: true, lastExtensionVersion: "0.3.8" },
			];
			for (const input of cases) {
				const report = formatStatusReport(input);
				for (const term of forbidden) {
					expect(report).not.toContain(term);
				}
			}
		});
	});
});

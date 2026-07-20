import { describe, expect, test } from "bun:test";
import {
	derivePresence,
	formatStatusLine,
	formatStatusReport,
	presenceThemeColor,
	STATUS_KEY,
	type StatusTheme,
} from "./status-surface";

const base = {
	pluginVersion: "0.3.15",
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

describe("status surface", () => {
	test("STATUS_KEY is stable for setStatus", () => {
		expect(STATUS_KEY).toBe("huddora");
	});

	test("derivePresence covers setup/online/offline/revoked", () => {
		expect(
			derivePresence({
				selfAgentId: null,
				lastError: null,
				heartbeatOk: false,
				bridgeReady: false,
			}),
		).toBe("needs_setup");
		expect(
			derivePresence({
				selfAgentId: "a",
				lastError: null,
				heartbeatOk: true,
				bridgeReady: true,
			}),
		).toBe("online");
		expect(
			derivePresence({
				selfAgentId: "a",
				lastError: "presence rebind pending",
				heartbeatOk: false,
				bridgeReady: true,
			}),
		).toBe("offline");
		expect(
			derivePresence({
				selfAgentId: "a",
				lastError: "agent revoked — open /account/agents",
				heartbeatOk: false,
				bridgeReady: true,
			}),
		).toBe("revoked");
		expect(
			derivePresence({
				selfAgentId: "a",
				lastError: null,
				heartbeatOk: true,
				bridgeReady: false,
			}),
		).toBe("offline");
	});

	test("formatStatusLine is glanceable with icons and essentials", () => {
		const line = formatStatusLine(base);
		expect(line).toBe("󰒍 Huddora 0.3.15  ● online   Alice's OMP  󰭹 Slupport");
		expect(formatStatusLine({ ...base, roomId: null, roomName: null })).toContain("no room");
		expect(formatStatusLine({ ...base, paused: true })).toContain("paused");
		expect(formatStatusLine({ ...base, presence: "offline" })).toContain("○ offline");
		expect(formatStatusLine({ ...base, presence: "needs_setup" })).toContain("needs setup");
		expect(formatStatusLine({ ...base, presence: "revoked" })).toContain("revoked");
		expect(
			formatStatusLine({
				...base,
				agentDisplayName: null,
				selfAgentId: null,
				presence: "needs_setup",
			}),
		).toContain("unbound");
	});

	test("formatStatusLine segments with theme colors", () => {
		const tags: string[] = [];
		const theme: StatusTheme = {
			fg: (color, text) => {
				tags.push(color);
				return `[${color}]${text}`;
			},
		};
		const line = formatStatusLine(base, theme);
		expect(line).toContain("[accent]󰒍 Huddora 0.3.15");
		expect(line).toContain("[success]● online");
		expect(line).toContain("[muted] Alice's OMP");
		expect(line).toContain("[muted]󰭹 Slupport");
		expect(tags).toEqual(["accent", "success", "muted", "muted"]);

		const paused = formatStatusLine({ ...base, presence: "offline", paused: true }, theme);
		expect(paused).toContain("[warning]○ offline");
		expect(paused).toContain("[warning]⏸ paused");
	});

	test("presenceThemeColor maps presence to theme roles", () => {
		expect(presenceThemeColor("online")).toBe("success");
		expect(presenceThemeColor("offline")).toBe("warning");
		expect(presenceThemeColor("revoked")).toBe("error");
		expect(presenceThemeColor("needs_setup")).toBe("dim");
	});

	test("formatStatusReport includes version, agent, room name, room_id", () => {
		const report = formatStatusReport(base);
		expect(report).toContain("󰒍 Huddora 0.3.15");
		expect(report).toContain("Loaded plugin v0.3.15 (this process)");
		expect(report).toContain("● online");
		expect(report).toContain(" Agent: Alice's OMP (registered)");
		expect(report).toContain("󰭹 Room: Slupport");
		expect(report).toContain("room_id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb (Slupport)");
		expect(report).toContain("Ready.");
		expect(formatStatusReport({ ...base, roomId: null, roomName: null, selfAgentId: null })).toContain(
			"Next: /huddora room",
		);
		expect(formatStatusLine(base, plainTheme)).toContain("Huddora 0.3.15");
		expect(
			formatStatusReport({ ...base, lastExtensionVersion: "0.3.8" }),
		).toContain("Last seat stamp: 0.3.8");
	});
});

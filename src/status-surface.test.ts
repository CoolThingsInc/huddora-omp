import { describe, expect, test } from "bun:test";
import { PREEMPTED_STATUS_MESSAGE } from "./agent-bind";
import {
	derivePresence,
	formatStatusLine,
	formatStatusReport,
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

describe("status surface", () => {
	test("STATUS_KEY is stable for setStatus", () => {
		expect(STATUS_KEY).toBe("huddora");
	});

	test("derivePresence covers setup/online/offline/revoked and reconnect", () => {
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
		expect(line).toBe("󰒍 Huddora 0.3.17  ● here   Alice's OMP  󰭹 Slupport");
		expect(formatStatusLine({ ...base, roomId: null, roomName: null })).toContain("no room");
		expect(formatStatusLine({ ...base, paused: true })).toContain("paused");
		expect(formatStatusLine({ ...base, presence: "offline" })).toContain("○ away");
		expect(formatStatusLine({ ...base, presence: "needs_setup" })).toContain("needs reconnect");
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
		expect(line).toContain("[accent]󰒍 Huddora 0.3.17");
		expect(line).toContain("[success]● here");
		expect(line).toContain("[muted] Alice's OMP");
		expect(line).toContain("[muted]󰭹 Slupport");
		expect(tags).toEqual(["accent", "success", "muted", "muted"]);

		const paused = formatStatusLine({ ...base, presence: "offline", paused: true }, theme);
		expect(paused).toContain("[warning]○ away");
		expect(paused).toContain("[warning]⏸ paused");
	});

	test("presenceThemeColor maps presence to theme roles", () => {
		expect(presenceThemeColor("online")).toBe("success");
		expect(presenceThemeColor("offline")).toBe("warning");
		expect(presenceThemeColor("revoked")).toBe("error");
		expect(presenceThemeColor("needs_setup")).toBe("dim");
	});

	test("formatStatusReport includes version, agent, room name, room_id", () => {
		const report = formatStatusReport({ ...base, seatExclusive: true });
		expect(report).toContain("󰒍 Huddora 0.3.17");
		expect(report).toContain("Loaded plugin v0.3.17 (this process)");
		expect(report).toContain("● here");
		expect(report).toContain(" Agent: Alice's OMP (registered)");
		expect(report).toContain("Seat: exclusive (this process holds the live session).");
		expect(report).toContain("󰭹 Room: Slupport");
		expect(report).toContain("room_id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb (Slupport)");
		expect(report).toContain("Ready.");
		expect(formatStatusReport({ ...base, roomId: null, roomName: null, selfAgentId: null })).toContain(
			"Next: /huddora room",
		);
		expect(formatStatusLine(base, plainTheme)).toContain("Huddora 0.3.17");
		expect(
			formatStatusReport({ ...base, lastExtensionVersion: "0.3.8" }),
		).toContain("Last seat stamp: 0.3.8");
		expect(
			formatStatusReport({
				...base,
				presence: "offline",
				seatExclusive: false,
				lastError: PREEMPTED_STATUS_MESSAGE,
			}),
		).toContain("Seat: not held");
		expect(
			formatStatusReport({
				...base,
				presence: "needs_setup",
				lastError: "presence rebind pending",
			}),
		).toContain("Next: /huddora connect");
	});
	test("formatStatusLine prefixes delivery light glyph when provided", () => {
		const line = formatStatusLine({ ...base, deliveryLight: "green" });
		// light glyph sits between brand and presence: brand  🟢  presence  agent  room
		expect(line).toContain("󰒍 Huddora 0.3.17  🟢  ● here");
		expect(line).toContain("● here");
		expect(line).toContain("Slupport");

		// amber / red also render
		expect(formatStatusLine({ ...base, deliveryLight: "amber" })).toContain("🟡");
		expect(formatStatusLine({ ...base, deliveryLight: "red" })).toContain("🔴");

		// omitting keeps the legacy compact order — no light glyph, presence matrix unchanged
		const legacy = formatStatusLine(base);
		expect(legacy).not.toContain("🟢");
		expect(legacy).not.toContain("🟡");
		expect(legacy).not.toContain("🔴");
		expect(legacy).toContain("● here");
	});

	test("formatStatusLine colors delivery light via theme", () => {
		const tags: string[] = [];
		const theme: StatusTheme = {
			fg: (color, text) => {
				tags.push(color);
				return `[${color}]${text}`;
			},
		};
		const line = formatStatusLine({ ...base, deliveryLight: "amber" }, theme);
		expect(line).toContain("[warning]🟡");
		// accent(brand) success(presence trail is light-after) muted muted — order preserved
		expect(tags).toEqual(["accent", "warning", "success", "muted", "muted"]);
		// legacy no-light path keeps prior tag order: accent success muted muted
		expect(
			(() => {
				const t2: string[] = [];
				formatStatusLine(base, { fg: (c, x) => (t2.push(c), x) });
				return t2;
			})(),
		).toEqual(["accent", "success", "muted", "muted"]);
	});

	test("formatStatusReport shows courier-primary bus line with lease + light", () => {
		const future = Date.now() + 90_000;
		const report = formatStatusReport({
			...base,
			seatExclusive: true,
			courierPrimary: true,
			leaseExpiresAt: future,
			deliveryLight: "green",
		});
		expect(report).toContain("Bus: courier-primary (lease + SSE wake + poll)");
		// lease_ttl may jitter ±1s on slow CI clocks; tolerate 8–90s window
		expect(report).toMatch(/lease_ttl=\d{1,5}s remaining/);
		expect(report).toContain("light=green");
		// presence matrix unchanged
		expect(report).toContain("● here");
		// doctor-oriented Next line kept as-is, no raw nextDueAt dumped
		expect(report).toContain("Ready.");
		expect(report).not.toContain("nextDueAt");
	});

	test("formatStatusReport hides bus line when courierPrimary is false", () => {
		const report = formatStatusReport({ ...base, courierPrimary: false });
		expect(report).not.toContain("courier-primary");
		// omission defaults to courier-primary shown
		expect(formatStatusReport(base)).toContain("Bus: courier-primary (lease + SSE wake + poll)");
	});
});

import { describe, expect, test } from "bun:test";
import {
	derivePresence,
	formatStatusLine,
	formatStatusReport,
	STATUS_KEY,
} from "./status-surface";

const base = {
	pluginVersion: "0.3.8",
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

	test("formatStatusLine is glanceable and includes essentials", () => {
		const line = formatStatusLine(base);
		expect(line).toBe("Huddora v0.3.8 · online · Alice's OMP · Slupport");
		expect(formatStatusLine({ ...base, roomId: null, roomName: null })).toContain("no room");
		expect(formatStatusLine({ ...base, paused: true })).toContain("paused");
		expect(formatStatusLine({ ...base, presence: "offline" })).toContain("offline");
		expect(
			formatStatusLine({
				...base,
				agentDisplayName: null,
				selfAgentId: null,
				presence: "needs_setup",
			}),
		).toContain("unbound");
	});

	test("formatStatusReport includes version, agent, room name, room_id", () => {
		const report = formatStatusReport(base);
		expect(report).toContain("Huddora v0.3.8 · online");
		expect(report).toContain("Agent: Alice's OMP (registered)");
		expect(report).toContain("Room: Slupport");
		expect(report).toContain("room_id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb (Slupport)");
		expect(report).toContain("Ready.");
		expect(formatStatusReport({ ...base, roomId: null, roomName: null, selfAgentId: null })).toContain(
			"Next: /huddora room",
		);
	});
});

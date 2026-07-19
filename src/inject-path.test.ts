/**
 * Host-level inject path harness without full AgentSession.
 * Proves: notify handler → gateInject policy → sendMessage options (steer / idle wake).
 */
import { describe, expect, test } from "bun:test";
import { chooseDeliverOptions, defaultRateGuard, gateInject } from "./deliver";
import {
	installChainedNotificationHandler,
	type NotifyHandler,
	__resetNotifyGenerationForTests,
} from "./notify-hook";
import { parseHuddoraMessagesNotification } from "./notifications";

describe("architecture H inject path", () => {
	test("sole-consumer notify delivers huddora method to sendMessage-shaped options", () => {
		__resetNotifyGenerationForTests();
		const injects: Array<{ deliverAs: string; triggerTurn: boolean; content: string }> = [];
		let isIdle = false;

		const sendMessage = (
			payload: { content: string },
			opts: { deliverAs: string; triggerTurn: boolean },
		) => {
			injects.push({
				deliverAs: opts.deliverAs,
				triggerTurn: opts.triggerTurn,
				content: payload.content,
			});
		};

		let current: NotifyHandler | undefined;
		const manager = {
			setOnNotification: (h: NotifyHandler) => {
				current = h;
			},
		};

		const hook = installChainedNotificationHandler(
			manager,
			(serverName, method, params) => {
				if (serverName !== "huddora") return;
				const parsed = parseHuddoraMessagesNotification(method, params);
				if (!parsed || parsed.messages.length === 0) return;
				const content = parsed.messages.map((m) => m.body).join("\n");
				const opts = chooseDeliverOptions(isIdle);
				const gated = gateInject(defaultRateGuard(), {
					isIdle,
					content,
					noise: false,
				});
				if (!gated) return;
				sendMessage({ content }, gated.options);
			},
			{ soleConsumer: true },
		);
		expect(hook.mode).toBe("sole_consumer");

		// Active turn → steer
		isIdle = false;
		current?.("huddora", "notifications/huddora/messages", {
			room_id: "r1",
			next_cursor: 2,
			messages: [
				{
					message_id: "m2",
					room_id: "r1",
					cursor: 2,
					author_id: "u",
					author_name: "Peer",
					body: "hello while streaming",
					client_message_id: "c2",
					created_at: "t",
				},
			],
		});
		expect(injects).toHaveLength(1);
		expect(injects[0]!.deliverAs).toBe("steer");
		expect(injects[0]!.triggerTurn).toBe(false);
		expect(injects[0]!.content).toContain("hello while streaming");

		// Ignore other servers
		current?.("other", "notifications/huddora/messages", {
			room_id: "r1",
			messages: [{ cursor: 3, body: "nope", author_id: "x" }],
		});
		expect(injects).toHaveLength(1);

		// Idle → nextTurn + triggerTurn
		isIdle = true;
		current?.("huddora", "notifications/huddora/messages", {
			room_id: "r1",
			next_cursor: 4,
			messages: [
				{
					message_id: "m4",
					room_id: "r1",
					cursor: 4,
					author_id: "u",
					author_name: "Peer",
					body: "wake idle",
					client_message_id: "c4",
					created_at: "t",
				},
			],
		});
		expect(injects).toHaveLength(2);
		expect(injects[1]!.deliverAs).toBe("nextTurn");
		expect(injects[1]!.triggerTurn).toBe(true);

		// Chain path with synthetic previous handler
		__resetNotifyGenerationForTests();
		const prior: string[] = [];
		let cur2: NotifyHandler | undefined = (s, m) => {
			prior.push(`${s}:${m}`);
		};
		const manager2 = {
			getOnNotification: () => cur2,
			setOnNotification: (h: NotifyHandler) => {
				cur2 = h;
			},
		};
		const hook2 = installChainedNotificationHandler(
			manager2,
			(s, m) => {
				if (s === "huddora" && m === "notifications/huddora/messages") {
					sendMessage({ content: "chained" }, { deliverAs: "steer", triggerTurn: false });
				}
			},
			{ soleConsumer: true },
		);
		expect(hook2.mode).toBe("chained_setOnNotification");
		cur2?.("huddora", "notifications/huddora/messages", {
			room_id: "r",
			messages: [
				{
					message_id: "m",
					room_id: "r",
					cursor: 1,
					author_id: "a",
					author_name: "A",
					body: "x",
					client_message_id: "c",
					created_at: "t",
				},
			],
		});
		expect(prior.some((p) => p.startsWith("huddora:"))).toBe(true);
		expect(injects.some((i) => i.content === "chained")).toBe(true);
		hook2.restore();
		hook.restore();
	});
});

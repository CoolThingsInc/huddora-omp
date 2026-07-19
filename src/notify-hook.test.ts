import { beforeEach, describe, expect, test } from "bun:test";
import {
	__resetNotifyGenerationForTests,
	installChainedNotificationHandler,
	type NotifyHandler,
} from "./notify-hook";

beforeEach(() => {
	__resetNotifyGenerationForTests();
});

describe("installChainedNotificationHandler", () => {
	test("no manager → not installed", () => {
		const h = installChainedNotificationHandler(null, () => {});
		expect(h.installed).toBe(false);
		expect(h.mode).toBe("none");
	});

	test("prefers multi-subscriber onNotification", () => {
		const calls: string[] = [];
		const subs = new Set<NotifyHandler>();
		const manager = {
			onNotification: (h: NotifyHandler) => {
				subs.add(h);
				return () => {
					subs.delete(h);
				};
			},
			setOnNotification: () => {
				throw new Error("should not use setOnNotification");
			},
		};
		const hook = installChainedNotificationHandler(manager, (s, m) => {
			calls.push(`${s}:${m}`);
		});
		expect(hook.installed).toBe(true);
		expect(hook.mode).toBe("onNotification");
		expect(hook.clobberedUnknown).toBe(false);
		for (const h of subs) h("huddora", "notifications/huddora/messages", {});
		expect(calls).toEqual(["huddora:notifications/huddora/messages"]);
		hook.restore();
		expect(subs.size).toBe(0);
	});

	test("chains previous via getOnNotification", () => {
		const calls: string[] = [];
		const prev: NotifyHandler = (s, m) => {
			calls.push(`prev:${s}:${m}`);
		};
		let current: NotifyHandler | undefined = prev;
		const manager = {
			getOnNotification: () => current,
			setOnNotification: (h: NotifyHandler) => {
				current = h;
			},
		};
		const hook = installChainedNotificationHandler(manager, (s, m) => {
			calls.push(`ours:${s}:${m}`);
		});
		expect(hook.installed).toBe(true);
		expect(hook.mode).toBe("chained_setOnNotification");
		expect(hook.clobberedUnknown).toBe(false);
		current?.("huddora", "notifications/huddora/messages", {});
		expect(calls).toEqual([
			"prev:huddora:notifications/huddora/messages",
			"ours:huddora:notifications/huddora/messages",
		]);
		hook.restore();
		current?.("huddora", "x", {});
		expect(calls.at(-1)).toBe("prev:huddora:x");
	});

	test("sole-consumer installs without getter (default)", () => {
		let current: NotifyHandler | undefined;
		const manager = {
			setOnNotification: (h: NotifyHandler) => {
				current = h;
			},
		};
		const seen: string[] = [];
		const hook = installChainedNotificationHandler(manager, (s) => {
			seen.push(s);
		});
		expect(hook.installed).toBe(true);
		expect(hook.mode).toBe("sole_consumer");
		expect(hook.clobberedUnknown).toBe(true);
		current?.("huddora", "notifications/huddora/messages", {});
		// handler must still receive; filtering is caller's job
		expect(seen).toEqual(["huddora"]);
		// other server name still delivered to ours — filter is outside
		current?.("other", "m", {});
		expect(seen).toEqual(["huddora", "other"]);
		hook.restore();
		// sole restore sets no-op
		const after = current;
		after?.("huddora", "m", {});
		expect(seen).toEqual(["huddora", "other"]);
	});

	test("soleConsumer false without getter → fail-closed", () => {
		let set = false;
		const manager = {
			setOnNotification: () => {
				set = true;
			},
		};
		const hook = installChainedNotificationHandler(manager, () => {}, { soleConsumer: false });
		expect(hook.installed).toBe(false);
		expect(hook.mode).toBe("none");
		expect(hook.clobberedUnknown).toBe(true);
		expect(set).toBe(false);
	});

	test("previous throw does not block ours", () => {
		const seen: string[] = [];
		let current: NotifyHandler | undefined = () => {
			throw new Error("prev boom");
		};
		const manager = {
			getOnNotification: () => current,
			setOnNotification: (h: NotifyHandler) => {
				current = h;
			},
		};
		installChainedNotificationHandler(manager, (s) => {
			seen.push(s);
		});
		expect(() => current?.("huddora", "m", {})).not.toThrow();
		expect(seen).toEqual(["huddora"]);
	});
});

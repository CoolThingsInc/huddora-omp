/**
 * MCP notification subscription for OMP host (architecture H).
 *
 * Preference:
 * 1. onNotification(handler) → unsubscribe (multi-subscriber, if host ever gains it)
 * 2. setOnNotification + getOnNotification: chain previous → ours, restore previous
 * 3. soleConsumer (default true): setOnNotification without getter — compatibility risk
 * 4. soleConsumer false / missing API → no install (poll only)
 *
 * Never scrapes credentials. Handlers only see serverName / method / params.
 * Callers MUST filter to server huddora + method notifications/huddora/messages.
 */

export type NotifyHandler = (serverName: string, method: string, params: unknown) => void;

export type ManagerLike = {
	setOnNotification?: (handler: NotifyHandler) => void;
	getOnNotification?: () => NotifyHandler | undefined;
	onNotification?: (handler: NotifyHandler) => () => void;
};

export type NotifyInstallMode =
	| "onNotification"
	| "chained_setOnNotification"
	| "sole_consumer"
	| "none";

export type NotifyHook = {
	installed: boolean;
	restore: () => void;
	/** True when previous handler was unknown (sole-consumer without getter). */
	clobberedUnknown: boolean;
	mode: NotifyInstallMode;
	reason?: string;
	generation: number;
};

export type InstallNotifyOptions = {
	/** Default true (architecture H). false = fail-closed when cannot chain. */
	soleConsumer?: boolean;
};

let installGeneration = 0;

export function installChainedNotificationHandler(
	manager: ManagerLike | null | undefined,
	ours: NotifyHandler,
	options: InstallNotifyOptions = {},
): NotifyHook {
	const soleConsumer = options.soleConsumer !== false;
	const generation = ++installGeneration;

	const none = (reason: string, clobberedUnknown = false): NotifyHook => ({
		installed: false,
		restore: () => {},
		clobberedUnknown,
		mode: "none",
		reason,
		generation,
	});

	if (!manager) return none("no_manager");

	// 1) Multi-subscriber
	if (typeof manager.onNotification === "function") {
		const unsubscribe = manager.onNotification(ours);
		return {
			installed: true,
			clobberedUnknown: false,
			mode: "onNotification",
			generation,
			restore: () => {
				try {
					unsubscribe();
				} catch {
					// ignore
				}
			},
		};
	}

	if (typeof manager.setOnNotification !== "function") {
		return none("no_setOnNotification");
	}

	// 2) Chain when getter exists
	if (typeof manager.getOnNotification === "function") {
		let previous: NotifyHandler | undefined;
		try {
			previous = manager.getOnNotification();
		} catch {
			if (!soleConsumer) return none("getOnNotification_threw", true);
			// sole-consumer without previous knowledge
			manager.setOnNotification(ours);
			return soleConsumerHook(manager, generation);
		}

		const chained: NotifyHandler = (serverName, method, params) => {
			try {
				previous?.(serverName, method, params);
			} catch {
				// ignore previous errors
			}
			ours(serverName, method, params);
		};
		manager.setOnNotification(chained);
		return {
			installed: true,
			clobberedUnknown: false,
			mode: "chained_setOnNotification",
			generation,
			restore: () => {
				if (generation !== installGeneration) return;
				try {
					if (previous) manager.setOnNotification?.(previous);
					else manager.setOnNotification?.(() => {});
				} catch {
					// ignore
				}
			},
		};
	}

	// 3) No getter
	if (!soleConsumer) {
		return none("no_getOnNotification_fail_closed", true);
	}

	manager.setOnNotification(ours);
	return soleConsumerHook(manager, generation);
}

function soleConsumerHook(manager: ManagerLike, generation: number): NotifyHook {
	return {
		installed: true,
		clobberedUnknown: true,
		mode: "sole_consumer",
		reason: "sole_consumer_opt_in",
		generation,
		restore: () => {
			// Clear only if this install is still the latest we issued.
			// Without getter we cannot verify we still own the slot (compat risk).
			if (generation !== installGeneration) return;
			try {
				manager.setOnNotification?.(() => {});
			} catch {
				// ignore
			}
		},
	};
}

/** Test helper. */
export function __resetNotifyGenerationForTests(): void {
	installGeneration = 0;
}

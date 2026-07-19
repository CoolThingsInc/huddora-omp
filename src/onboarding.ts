/**
 * Pure onboarding policy helpers — unit-tested without ExtensionAPI.
 * The extension owns timers/IO; this module owns the decision rules.
 */

export type RoomBindSource = "config" | "single" | "session" | "legacy";

export type RoomBindDecision =
	| { action: "bind"; roomId: string; source: RoomBindSource; preserveCursor: boolean }
	| { action: "reuse" }
	| { action: "clear_root" }
	| { action: "wait_transport" }
	| { action: "prompt_choose" }
	| { action: "prompt_empty" }
	| { action: "none" };

/** Aggressive exponential delays for the first 6 failures, then a slow forever re-arm. */
export function nextOnboardingDelayMs(attemptAfterFailure: number): number {
	if (attemptAfterFailure <= 6) return Math.min(30_000, 1_000 * 2 ** attemptAfterFailure);
	return 15_000;
}

/** Any real connection-status change re-arms the aggressive budget (covers late /mcp reauth). */
export function shouldResetOnboardingBudget(lastStatus: string | null, status: string): boolean {
	return lastStatus !== null && status !== lastStatus;
}

/**
 * Decide how autoConnect should bind a room for the current canonical root.
 * transportReady means host MCP connected OR compatibility bridge can start.
 */
export function decideRoomBinding(input: {
	root: string;
	configRoomId: string | null;
	stateRoomId: string | null;
	stateProjectRoot: string | null;
	rooms: ReadonlyArray<{ room_id: string }>;
	transportReady: boolean;
}): RoomBindDecision {
	const { root, configRoomId, stateRoomId, stateProjectRoot, rooms, transportReady } = input;

	if (stateRoomId && stateProjectRoot && stateProjectRoot !== root) {
		return { action: "clear_root" };
	}
	if (stateRoomId && stateProjectRoot === root) {
		return { action: "reuse" };
	}
	if (!transportReady) return { action: "wait_transport" };

	if (configRoomId) {
		return { action: "bind", roomId: configRoomId, source: "config", preserveCursor: false };
	}
	// v0.2: validated session room, ephemeral for this root, preserve cursor, never write config.
	if (stateRoomId && stateProjectRoot === null) {
		return { action: "bind", roomId: stateRoomId, source: "legacy", preserveCursor: true };
	}
	if (rooms.length === 1) {
		return { action: "bind", roomId: rooms[0]!.room_id, source: "single", preserveCursor: false };
	}
	if (rooms.length === 0) return { action: "prompt_empty" };
	return { action: "prompt_choose" };
}

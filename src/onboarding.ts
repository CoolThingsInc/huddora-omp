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

/** Doctor "Next:" — bridge-only; reauth only for missing/invalid OAuth for the bridge. */
export function doctorNextStep(input: {
	roomId: string | null;
	connection: string;
	delivery: string;
	bridgeDisabled?: boolean;
	bridgeError?: string | null;
}): string {
	if (input.roomId && (input.delivery === "bridge" || input.delivery === "poll")) return "ready";
	if (input.roomId) return "ready";
	if (input.delivery === "bridge") return "wait for auto-bind or run /huddora room";
	if (input.bridgeDisabled) return "run /huddora bridge on (bridge is required for plugin tools)";
	const err = (input.bridgeError ?? "").toLowerCase();
	if (
		input.connection === "disconnected" ||
		/reauth|oauth|credential|expired|401|unauthoriz|missing/.test(err)
	) {
		return "run /mcp reauth huddora (OAuth token missing/expired for bridge)";
	}
	return "run /huddora bridge on (or wait for auto-bridge)";
}

/** Map room_list failures without blanket reauth. */
export function roomToolFailureMessage(error: { kind: string; message: string }): string {
	if (error.kind === "no_manager" || error.kind === "no_host_api") {
		return "Compatibility bridge not active. Run /huddora bridge on.";
	}
	if (error.kind === "disconnected") {
		return error.message;
	}
	if (/401|unauthoriz|reauth|credential|expired|forbidden/i.test(error.message)) {
		return `${error.message} Run /mcp reauth huddora.`;
	}
	return `room_list failed: ${error.message}`;
}

/**
 * Decide how autoConnect should bind a room for the current canonical root.
 * transportReady means the compatibility bridge is active (bridge-only plugin).
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

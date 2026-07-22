/**
 * Pure human-facing operation notification copy for the Huddora OMP extension.
 *
 * Centralizes repeated one-liner toasts/notifications shown to the user after
 * transport, room, pause/resume, sync, preemption, and push-preference events.
 * Every exported string starts with `Huddora:` and names a concrete next
 * action. No IO here — the extension owns timing/transport; this module only
 * shapes strings.
 *
 * No operator jargon leaks into the human surface: no bridge, courier-primary,
 * mute-trap, seat stamp, MCPManager, lease_ttl, session_key, or xd://. That
 * vocabulary belongs to model-facing guidance, not user notifications.
 */

/** Uniform prefix shared by every notification string. */
const PREFIX = "Huddora:";

/** True when the error signature suggests a missing/expired OAuth credential. */
function looksLikeCredentialError(error: string | null | undefined): boolean {
	const e = (error ?? "").toLowerCase();
	return /oauth|token|401|unauthoriz|reauth|credential|expired|forbidden|missing/.test(e);
}

/**
 * One actionable sentence when the MCP transport is unavailable.
 *
 * Mentions `/mcp reauth huddora` only when the error signature indicates the
 * OAuth credential is likely missing or expired; otherwise points at
 * `/huddora connect` as the general recovery path.
 *
 * @param action    optional human verb for context ("sync", "connect", …).
 * @param errorHint  optional last-error string used to decide reauth vs connect.
 */
export function transportUnavailable(
	action?: string,
	errorHint?: string | null,
): string {
	const verb = action ? ` during ${action}` : "";
	if (looksLikeCredentialError(errorHint)) {
		return `${PREFIX} connection unavailable${verb}. Run /mcp reauth huddora to refresh credentials, then /huddora connect.`;
	}
	return `${PREFIX} connection unavailable${verb}. Run /huddora connect to re-establish it.`;
}

/**
 * Prompt the user to create or join a room, then bind it.
 */
export function roomNeeded(): string {
	return `${PREFIX} no room selected. Create or join a room at huddora.coolthings.fyi, then /huddora room <room_id>.`;
}

/**
 * Friendly connection-success notification.
 *
 * @param roomName   optional display name of the bound room.
 * @param remembered whether room binding was persisted to project config.
 */
export function connected(roomName?: string | null, remembered?: boolean): string {
	const where = roomName?.trim() ? ` to ${roomName.trim()}` : "";
	const note = remembered ? " — room saved to project config" : "";
	return `${PREFIX} connected${where}.${note}`;
}

/** Paused notification — updates are on hold. */
export function paused(): string {
	return `${PREFIX} updates paused. Run /huddora resume to continue.`;
}

/** Resumed notification — updates flowing again. */
export function resumed(): string {
	return `${PREFIX} updates resumed.`;
}

/** Disconnected notification with a concrete recovery action. */
export function disconnected(): string {
	return `${PREFIX} disconnected. Run /huddora connect to reconnect.`;
}

/** Input for {@link syncResult}. */
export type SyncResultInput = {
	newMessages: number;
	/** Optional error message; when non-empty the result reflects failure. */
	error?: string | null;
};

/** Pluralize “message” for the given count. */
function plural(count: number): string {
	return count === 1 ? "message" : "messages";
}

/**
 * Human copy for a sync outcome.
 *
 * On success reports the number of new messages. On error reports the failure
 * with a retry hint. Never mentions cursor, in-flight, or operator internals.
 */
export function syncResult(input: SyncResultInput): string {
	if (input.error) {
		return `${PREFIX} sync failed: ${input.error.trim()}. Run /huddora sync to retry.`;
	}
	const n = input.newMessages;
	if (n <= 0) return `${PREFIX} up to date — no new messages.`;
	return `${PREFIX} synced ${n} new ${plural(n)}.`;
}

/** Another OMP window took over the connection; how to move it back here. */
export function preempted(): string {
	return `${PREFIX} another window is connected. Run /huddora connect to move the connection here.`;
}

/** Toggle copy for live-update preference, without bridge/SSE/poll jargon. */
export function pushPreference(enabled: boolean): string {
	return enabled
		? `${PREFIX} live updates on.`
		: `${PREFIX} live updates off.`;
}

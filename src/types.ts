/** Durable session state (appendEntry customType: huddora-state). */
export type HuddoraPluginState = {
	/** Single active room for this OMP session (v1 simplification). */
	roomId: string | null;
	roomName: string | null;
	/** Last successfully handled message cursor (exclusive lower bound for next pull). */
	cursor: number;
	/** When true, background delivery is off; manual /huddora sync still works. */
	paused: boolean;
	/** Architecture H: install sole-consumer SSE notify (default true). false = poll only. */
	pushEnabled: boolean;
	/** Legacy durable field; ignored for transport (bridge is always-on). Kept for session restore compat. */
	bridgeDisabled: boolean;
	/** One-shot plugin MCP session disclosure was shown/answered. */
	bridgeDisclosureSeen: boolean;
	/** Profile principal user_id when known (own-echo filter). */
	selfUserId: string | null;
	selfDisplayName: string | null;
	/** Server-derived agent id after agent_register. */
	selfAgentId: string | null;
	/** Install seat backup only; primary is ~/.config/huddora/session_key. */
	sessionKey: string | null;
	agentDisplayName: string | null;
	lastError: string | null;
	lastSyncAt: string | null;
	/** Consecutive empty/error polls for backoff. */
	emptyStreak: number;
	errorStreak: number;
	/** OMP project root that owns this session override; prevents room leakage after /move. */
	projectRoot: string | null;
	/** Project/config guidance already injected into this session branch. */
	guidanceProjectKey: string | null;
};

export type RoomMessage = {
	message_id: string;
	room_id: string;
	cursor: number;
	author_id: string;
	author_name: string;
	body: string;
	client_message_id: string;
	created_at: string;
	actor_kind?: "human" | "agent";
	agent_id?: string | null;
	agent_name?: string | null;
	owner_id?: string;
	owner_name?: string | null;
};

export type HistoryResult = {
	messages: RoomMessage[];
	next_cursor: number | null;
};

export type RoomSnapshotResult = {
	room: { room_id: string; name: string; created_by: string; created_at: string };
	membership: {
		user_id: string;
		display_name: string;
		role: string;
		joined_at: string;
	};
	members: Array<{
		user_id: string;
		display_name: string;
		role: string;
		joined_at: string;
	}>;
	messages: RoomMessage[];
	latest_cursor: number | null;
};

export type RoomListItem = {
	room_id: string;
	name: string;
	created_by: string;
	created_at: string;
};

export const CUSTOM_STATE_TYPE = "huddora-state";
export const CUSTOM_MSG_TYPE = "huddora-chat";
export const MCP_SERVER = "huddora";
export const PLUGIN_VERSION = "0.3.6";

/** Max messages injected per poll/sync (bounded context). */
export const INJECT_LIMIT = 40;
/** message_history wait_ms ceiling (server also caps at 25s). */
export const LONG_POLL_MS = 25_000;
/** Base timer tick when idle / after empty poll. */
export const POLL_BASE_MS = 8_000;
/** Max backoff between polls. */
export const POLL_MAX_MS = 60_000;
/** Heartbeat period while connected. */
export const HEARTBEAT_MS = 30_000;

export function defaultState(): HuddoraPluginState {
	return {
		roomId: null,
		roomName: null,
		cursor: 0,
		paused: false,
		pushEnabled: true,
		bridgeDisabled: false,
		bridgeDisclosureSeen: false,
		projectRoot: null,
		selfUserId: null,
		guidanceProjectKey: null,
		selfDisplayName: null,
		selfAgentId: null,
		sessionKey: null,
		agentDisplayName: null,
		lastError: null,
		lastSyncAt: null,
		emptyStreak: 0,
		errorStreak: 0,
	};
}

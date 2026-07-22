/**
 * Source-of-truth command registry for the Huddora OMP extension.
 * Pure metadata + menu policy only — no business handlers, timers, or IO.
 * Integration consumes these exports to drive registerCommand and package.json.
 */

export type CommandName =
	| "init"
	| "config"
	| "room"
	| "help"
	| "status"
	| "doctor"
	| "connect"
	| "push"
	| "pause"
	| "resume"
	| "sync"
	| "disconnect";

export type CommandMeta = {
	name: CommandName;
	description: string;
	/** True for low-level settings commands omitted from the primary action menu. */
	hiddenFromMenu: boolean;
};

/**
 * The full set of runtime commands handled by the extension's /huddora switch.
 * Keep this in lockstep with the switch cases in extension.ts.
 */
export const HUDDORA_COMMANDS: readonly Readonly<CommandMeta>[] = [
	{ name: "init", description: "Create .huddora/config.json with defaults for this project root", hiddenFromMenu: false },
	{ name: "config", description: "Show the current Huddora project config (.huddora/config.json)", hiddenFromMenu: false },
	{ name: "room", description: "List rooms or bind <id> to this session; optionally save it as the project default", hiddenFromMenu: false },
	{ name: "help", description: "Show Huddora collaboration guidance", hiddenFromMenu: false },
	{ name: "status", description: "Full status report: presence, agent, room, delivery, config", hiddenFromMenu: false },
	{ name: "doctor", description: "Run diagnostics and show the recommended next step", hiddenFromMenu: false },
	{ name: "connect", description: "Reconnect to Huddora and bind a room now", hiddenFromMenu: false },
	// push is a low-level delivery toggle; surfaced via status, not as a primary menu action.
	{ name: "push", description: "Turn live updates on or off", hiddenFromMenu: true },
	{ name: "pause", description: "Pause room updates", hiddenFromMenu: false },
	{ name: "resume", description: "Resume room updates after a pause", hiddenFromMenu: false },
	{ name: "sync", description: "Check for new room messages now", hiddenFromMenu: false },
	{ name: "disconnect", description: "Disconnect from Huddora and reset session state", hiddenFromMenu: false },
] as const;

/**
 * Manifest entries suitable for package.json `omp.commands`, formatted `/huddora <name>`.
 * Order matches HUDDORA_COMMANDS.
 */
export const HUDDORA_COMMAND_NAMES: readonly string[] = HUDDORA_COMMANDS.map(
	(c) => `/huddora ${c.name}`,
);

/** Description string for ExtensionAPI registerCommand (the /huddora <args> surface). */
export function commandDescription(): string {
	return `Huddora: ${HUDDORA_COMMANDS.map((c) => c.name).join("|")}`;
}

export type MenuActionId =
	| "pick_room"
	| "setup"
	| "status"
	| "help"
	| "sync"
	| "pause"
	| "resume"
	| "switch_room"
	| "reconnect"
	| "reauth"
	| "doctor"
	| "disconnect";

export type MenuAction = {
	id: MenuActionId;
	label: string;
	description: string;
	/** Destructive actions are valid to offer but must render clearly as such. */
	destructive?: boolean;
};

/**
 * Runtime menu input derives from durable plugin state + transport signals.
 * connection follows getHuddoraConnectionStatus vocabulary ("bridge" = online).
 */
export type MenuState = {
	roomId: string | null;
	/** "bridge" means the plugin transport is online; anything else is offline/needs setup. */
	connection: string;
	paused: boolean;
	lastError: string | null;
};

// OAuth / credential failure signature shared with onboarding.roomToolFailureMessage.
const OAUTH_ERROR = /oauth|reauth|credential|expired|401|unauthoriz/i;

const SETUP: MenuAction = {
	id: "setup",
	label: "Setup config",
	description: "Create the Huddora project config for this root",
};
const PICK_ROOM: MenuAction = {
	id: "pick_room",
	label: "Pick a room",
	description: "List or bind a Huddora room for this session",
};
const STATUS: MenuAction = {
	id: "status",
	label: "Status",
	description: "Show full Huddora status report",
};
const HELP: MenuAction = {
	id: "help",
	label: "Help",
	description: "Show Huddora collaboration guidance",
};
const SYNC: MenuAction = {
	id: "sync",
	label: "Sync now",
	description: "Check for new room messages now",
};
const PAUSE: MenuAction = {
	id: "pause",
	label: "Pause delivery",
	description: "Pause room updates",
};
const RESUME: MenuAction = {
	id: "resume",
	label: "Resume delivery",
	description: "Resume room updates after a pause",
};
const SWITCH_ROOM: MenuAction = {
	id: "switch_room",
	label: "Switch room",
	description: "List rooms or bind a different room id",
};
const RECONNECT: MenuAction = {
	id: "reconnect",
	label: "Reconnect",
	description: "Reconnect to Huddora and bind a room now",
};
const REAUTH: MenuAction = {
	id: "reauth",
	label: "Reauth",
	description: "Run /mcp reauth huddora — OAuth token missing or expired",
};
const DOCTOR: MenuAction = {
	id: "doctor",
	label: "Doctor",
	description: "Diagnostics and the recommended next step",
};
const DISCONNECT: MenuAction = {
	id: "disconnect",
	label: "Disconnect",
	description: "Disconnect from Huddora and reset session state",
	destructive: true,
};

function isOAuthFailure(input: MenuState): boolean {
	return Boolean(input.lastError) && OAUTH_ERROR.test(input.lastError ?? "");
}

/**
 * Derive 3–5 state-aware, non-destructive menu actions for the given state.
 * No-room: pick room / setup / status or help.
 * Offline/error: reconnect (reauth when OAuth/token/401), status/doctor.
 * Online: sync, pause/resume, switch room, status; disconnect may appear, clearly destructive.
 */
export function deriveMenuActions(input: MenuState): MenuAction[] {
	const online = input.connection === "bridge";
	const hasRoom = Boolean(input.roomId);

	// No room bound: never offer sync/pause/disconnect (they require a room).
	if (!hasRoom) {
		const actions: MenuAction[] = [PICK_ROOM, SETUP, STATUS];
		if (isOAuthFailure(input)) actions.push(REAUTH);
		actions.push(HELP);
		return actions.slice(0, 5);
	}

	// Room bound but transport down / error: recovery menu.
	if (!online) {
		const actions: MenuAction[] = [];
		if (isOAuthFailure(input)) {
			actions.push(REAUTH, RECONNECT);
		} else {
			actions.push(RECONNECT);
		}
		actions.push(STATUS, DOCTOR);
		actions.push(HELP);
		return actions.slice(0, 5);
	}

	// Online with a bound room: operational menu.
	const actions: MenuAction[] = [];
	if (input.paused) {
		actions.push(RESUME);
	} else {
		actions.push(SYNC, PAUSE);
	}
	actions.push(SWITCH_ROOM, STATUS);
	// Disconnect is valid but destructive — always last so it is never the default.
	actions.push(DISCONNECT);
	return actions.slice(0, 5);
}

/** The default action id derived from state — always the first non-destructive choice. */
export function defaultMenuAction(input: MenuState): MenuAction["id"] {
	return deriveMenuActions(input)[0]!.id;
}

/**
 * Pure helpers for the plugin-bound room-task xdev tools.
 *
 * The plugin exposes five discoverable, bridge-bound tools so a model can take
 * responsibility for a directed task without the host MCP seat:
 *   huddora_task_list       -> server MCP task_list
 *   huddora_task_accept     -> server MCP task_accept
 *   huddora_task_handoff    -> server MCP task_handoff
 *   huddora_task_complete   -> server MCP task_complete
 *   huddora_task_fail       -> server MCP task_fail
 *
 * The bound agent id is never a model input — the server derives it from the
 * plugin session and validates ownership/assignment. These helpers only shape
 * and validate model args; they never accept or surface actor identity.
 */

export const UUID_RE = /^[0-9a-fA-F-]{36}$/;
export const MAX_FAILURE_REASON = 500;

export type BridgeCallResult =
	| { ok: true; data: unknown }
	| { ok: false; message: string };

export type TaskStatus = "pending" | "accepted" | "completed" | "failed";

export type TaskListParams = {
	room_id: string;
	status?: TaskStatus | string;
};

export type TaskTargetParams = {
	task_id: string;
};

export type TaskHandoffParams = {
	task_id: string;
	target_agent_id: string;
};

export type TaskCompleteParams = {
	task_id: string;
	result_message_id?: string;
};

export type TaskFailParams = {
	task_id: string;
	failure_reason?: string;
};

/** Returns a copy of a truthy, non-whitespace string param, trimmed; else null. */
function clean(s: unknown): string | null {
	if (typeof s !== "string") return null;
	const t = s.trim();
	return t.length > 0 ? t : null;
}

/**
 * Build server `task_list` args. The plugin surface is agent-facing: it always
 * pins `mine: true` so the server filters to tasks assigned to the bound seat,
 * and never exposes an option to turn the identity filter off. Status is
 * optional and omitted when blank.
 */
export function buildTaskListArgs(
	params: TaskListParams,
): { room_id: string; mine: true; status?: string } | { error: string } {
	const roomId = clean(params.room_id);
	if (!roomId) return { error: "room_id is required" };
	if (!UUID_RE.test(roomId)) return { error: "room_id must be a UUID" };
	const status = clean(params.status);
	const args: { room_id: string; mine: true; status?: string } = { room_id: roomId, mine: true };
	if (status) args.status = status;
	return args;
}

/** Build server `task_accept` args. */
export function buildTaskAcceptArgs(
	params: TaskTargetParams,
): { task_id: string } | { error: string } {
	const taskId = clean(params.task_id);
	if (!taskId) return { error: "task_id is required" };
	if (!UUID_RE.test(taskId)) return { error: "task_id must be a UUID" };
	return { task_id: taskId };
}

/** Build server `task_handoff` args. */
export function buildTaskHandoffArgs(
	params: TaskHandoffParams,
): { task_id: string; target_agent_id: string } | { error: string } {
	const taskId = clean(params.task_id);
	if (!taskId) return { error: "task_id is required" };
	if (!UUID_RE.test(taskId)) return { error: "task_id must be a UUID" };
	const target = clean(params.target_agent_id);
	if (!target) return { error: "target_agent_id is required" };
	if (!UUID_RE.test(target)) return { error: "target_agent_id must be a UUID" };
	return { task_id: taskId, target_agent_id: target };
}

/** Build server `task_complete` args; result_message_id optional but validated as UUID when present. */
export function buildTaskCompleteArgs(
	params: TaskCompleteParams,
): { task_id: string; result_message_id?: string } | { error: string } {
	const taskId = clean(params.task_id);
	if (!taskId) return { error: "task_id is required" };
	if (!UUID_RE.test(taskId)) return { error: "task_id must be a UUID" };
	const args: { task_id: string; result_message_id?: string } = { task_id: taskId };
	const resultId = clean(params.result_message_id);
	if (resultId) {
		if (!UUID_RE.test(resultId)) return { error: "result_message_id must be a UUID" };
		args.result_message_id = resultId;
	}
	return args;
}

/** Build server `task_fail` args; failure_reason optional but bounded to MAX_FAILURE_REASON when present. */
export function buildTaskFailArgs(
	params: TaskFailParams,
): { task_id: string; failure_reason?: string } | { error: string } {
	const taskId = clean(params.task_id);
	if (!taskId) return { error: "task_id is required" };
	if (!UUID_RE.test(taskId)) return { error: "task_id must be a UUID" };
	const args: { task_id: string; failure_reason?: string } = { task_id: taskId };
	const reason = clean(params.failure_reason);
	if (reason) {
		if (reason.length > MAX_FAILURE_REASON) {
			return { error: `failure_reason must be ${MAX_FAILURE_REASON} characters or fewer` };
		}
		args.failure_reason = reason;
	}
	return args;
}

/** Format bridge result for the model tool surface. Mirrors send-tool's formatter. */
export function formatTaskToolResult(result: BridgeCallResult, label: string): {
	content: Array<{ type: "text"; text: string }>;
	isError?: true;
	details: Record<string, unknown>;
} {
	if (result.ok) {
		const text =
			typeof result.data === "string"
				? result.data
				: JSON.stringify(result.data ?? {}, null, 0);
		return {
			content: [{ type: "text", text }],
			details: { ok: true },
		};
	}
	return {
		content: [{ type: "text", text: result.message }],
		isError: true,
		details: { ok: false, error: result.message, label },
	};
}

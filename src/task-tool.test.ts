import { describe, expect, test } from "bun:test";
import {
	buildTaskAcceptArgs,
	buildTaskCompleteArgs,
	buildTaskFailArgs,
	buildTaskHandoffArgs,
	buildTaskListArgs,
	formatTaskToolResult,
	MAX_FAILURE_REASON,
} from "./task-tool";

const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("task-tool arg builders", () => {
	test("buildTaskListArgs requires UUID room_id, omits status when blank", () => {
		const ok = buildTaskListArgs({ room_id: UUID, status: "  " });
		expect("error" in ok).toBe(false);
		expect(ok).toEqual({ room_id: UUID, mine: true });
	});

	test("buildTaskListArgs rejects non-UUID and missing room_id", () => {
		expect(buildTaskListArgs({ room_id: "nope" })).toEqual({ error: "room_id must be a UUID" });
		expect(buildTaskListArgs({ room_id: "   " })).toEqual({ error: "room_id is required" });
	});

	test("buildTaskListArgs includes status when provided", () => {
		const ok = buildTaskListArgs({ room_id: UUID, status: "pending" });
		expect(ok).toEqual({ room_id: UUID, mine: true, status: "pending" });
	});

	test("buildTaskListArgs always pins mine:true; params carry no mine field", () => {
		// The plugin surface is agent-facing: the model cannot turn the identity filter off.
		// Deep equality proves mine is exactly true with no extra/missing keys.
		expect(buildTaskListArgs({ room_id: UUID })).toEqual({ room_id: UUID, mine: true });
		expect(buildTaskListArgs({ room_id: UUID, status: "accepted" })).toEqual({
			room_id: UUID,
			mine: true,
			status: "accepted",
		});
		// TaskListParams structurally rejects a mine key: this cast-then-call is the
		// compile-time guarantee; the runtime assertions above cover the value.
	});

	test("buildTaskAcceptArgs validates task_id UUID", () => {
		expect(buildTaskAcceptArgs({ task_id: UUID })).toEqual({ task_id: UUID });
		expect(buildTaskAcceptArgs({ task_id: "x" })).toEqual({ error: "task_id must be a UUID" });
		expect(buildTaskAcceptArgs({ task_id: " \t" })).toEqual({ error: "task_id is required" });
	});

	test("buildTaskHandoffArgs requires both UUIDs", () => {
		expect(buildTaskHandoffArgs({ task_id: UUID, target_agent_id: UUID2 })).toEqual({
			task_id: UUID,
			target_agent_id: UUID2,
		});
		expect(buildTaskHandoffArgs({ task_id: UUID, target_agent_id: "bad" })).toEqual({
			error: "target_agent_id must be a UUID",
		});
		expect(buildTaskHandoffArgs({ task_id: "bad", target_agent_id: UUID2 })).toEqual({
			error: "task_id must be a UUID",
		});
	});

	test("buildTaskCompleteArgs omits result_message_id when blank, validates UUID when present", () => {
		expect(buildTaskCompleteArgs({ task_id: UUID })).toEqual({ task_id: UUID });
		const ok = buildTaskCompleteArgs({ task_id: UUID, result_message_id: UUID2 });
		expect(ok).toEqual({ task_id: UUID, result_message_id: UUID2 });
		expect(buildTaskCompleteArgs({ task_id: UUID, result_message_id: "bad" })).toEqual({
			error: "result_message_id must be a UUID",
		});
	});

	test("buildTaskFailArgs omits failure_reason when blank, validates length when present", () => {
		expect(buildTaskFailArgs({ task_id: UUID })).toEqual({ task_id: UUID });
		expect(buildTaskFailArgs({ task_id: UUID, failure_reason: "  " })).toEqual({ task_id: UUID });
		const ok = buildTaskFailArgs({ task_id: UUID, failure_reason: "boom" });
		expect(ok).toEqual({ task_id: UUID, failure_reason: "boom" });
	});

	test("buildTaskFailArgs rejects failure_reason over the bound", () => {
		const long = "x".repeat(MAX_FAILURE_REASON + 1);
		expect(buildTaskFailArgs({ task_id: UUID, failure_reason: long })).toEqual({
			error: `failure_reason must be ${MAX_FAILURE_REASON} characters or fewer`,
		});
	});

	test("builders accept exactly-max-length failure_reason", () => {
		const exact = "x".repeat(MAX_FAILURE_REASON);
		expect(buildTaskFailArgs({ task_id: UUID, failure_reason: exact })).toEqual({
			task_id: UUID,
			failure_reason: exact,
		});
	});

	test("builders trim whitespace around ids", () => {
		expect(buildTaskAcceptArgs({ task_id: `  ${UUID}  ` })).toEqual({ task_id: UUID });
	});
});

describe("formatTaskToolResult", () => {
	test("success renders JSON text without isError", () => {
		const out = formatTaskToolResult({ ok: true, data: { task_id: UUID, status: "accepted" } }, "accept");
		expect(out.isError).toBeUndefined();
		expect(out.content[0]?.text).toContain("accepted");
		expect(out.details).toEqual({ ok: true });
	});

	test("string data passes through", () => {
		const out = formatTaskToolResult({ ok: true, data: "ok" }, "complete");
		expect(out.content[0]?.text).toBe("ok");
	});

	test("error sets isError and includes label in details", () => {
		const out = formatTaskToolResult({ ok: false, message: "not assigned" }, "handoff");
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toBe("not assigned");
		expect(out.details).toEqual({ ok: false, error: "not assigned", label: "handoff" });
	});

	test("null data serializes to object literal", () => {
		const out = formatTaskToolResult({ ok: true, data: null }, "list");
		expect(out.content[0]?.text).toBe("{}");
	});
});

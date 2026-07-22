import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HUDDORA_COMMAND_NAMES } from "./commands.ts";
import { syncCommands } from "../scripts/sync-command-manifest.ts";

const PKG_PATH = resolve(import.meta.dirname, "..", "package.json");

function readOmpCommands(): string[] {
	const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8")) as {
		omp?: { commands?: string[] };
	};
	return pkg.omp?.commands ?? [];
}

test("package.json omp.commands exactly equals HUDDORA_COMMAND_NAMES", () => {
	const manifest = readOmpCommands();
	expect(manifest).toEqual([...HUDDORA_COMMAND_NAMES]);
});

test("every runtime command appears exactly once in the manifest", () => {
	const manifest = readOmpCommands();
	const expected = [...HUDDORA_COMMAND_NAMES];
	expect(manifest.length).toBe(expected.length);
	expect(new Set(manifest).size).toBe(manifest.length);
	for (const name of expected) {
		expect(manifest.filter((c) => c === name).length).toBe(1);
	}
});

test("syncCommands is idempotent without invoking an external process", () => {
	// First synchronization: writes the manifest directly to package.json.
	syncCommands();
	// Second synchronization: writing again must produce no change.
	syncCommands();
	const manifest = readOmpCommands();
	expect(manifest).toEqual([...HUDDORA_COMMAND_NAMES]);
});

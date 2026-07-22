/**
 * Mechanical manifest synchronizer: replaces package.json `omp.commands`
 * with the exact list from src/commands.ts HUDDORA_COMMAND_NAMES.
 *
 * Run under Bun:  `bun run sync:commands`
 *
 * - Reads package.json, replaces ONLY the omp.commands array, preserves
 *   every other field and key order.
 * - Writes deterministic JSON: tab-indented, single trailing newline.
 * - The `syncCommands` function is exported for in-process idempotency tests.
 */

import { HUDDORA_COMMAND_NAMES } from "../src/commands.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PKG_PATH = resolve(import.meta.dirname, "..", "package.json");

/** Deterministic serializer: tab-indented JSON preserving object key order, no trailing whitespace. */
function stringifyTabbed(value: unknown): string {
	return JSON.stringify(value, null, "\t");
}

/**
 * Replace omp.commands in package.json with `names`.
 * Returns the manifest array that was written, so callers can assert equality.
 */
export function syncCommands(names: readonly string[] = HUDDORA_COMMAND_NAMES): string[] {
	const raw = readFileSync(PKG_PATH, "utf8");
	const pkg = JSON.parse(raw) as { omp?: Record<string, unknown> };

	if (!pkg.omp || typeof pkg.omp !== "object" || Array.isArray(pkg.omp)) {
		throw new Error("package.json: omp field is missing or not an object");
	}
	pkg.omp.commands = [...names];

	const out = `${stringifyTabbed(pkg)}\n`;
	writeFileSync(PKG_PATH, out, "utf8");
	return [...names];
}

// Execute when run directly as a script (not imported by tests).
if (import.meta.main) {
	const written = syncCommands();
	console.log(`sync:commands → wrote ${written.length} entries to omp.commands`);
}

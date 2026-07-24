import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_VERSION } from "./types";

describe("version sync", () => {
	test("PLUGIN_VERSION is loaded from package.json", () => {
		const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
			version: string;
		};
		expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(PLUGIN_VERSION).toBe(pkg.version);
	});
});

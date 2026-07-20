import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_VERSION } from "./types";

describe("version sync", () => {
	test("package.json version matches PLUGIN_VERSION constant", () => {
		const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
			version: string;
		};
		expect(pkg.version).toBe(PLUGIN_VERSION);
		expect(PLUGIN_VERSION).toBe("0.3.17");
	});
});

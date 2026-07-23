#!/usr/bin/env bun
// Dependency-free Agent Skills validator for bundled skills/*/SKILL.md.
// Run: bun run check:skills
//
// Contract:
//   - SKILL.md exists; frontmatter parsed (minimal YAML, no deps)
//   - name: required, non-empty, kebab-case, equals the directory name
//   - description: required, non-empty, <=1024 chars
//   - metadata (optional): every value must be a string
//   - top-level `version`: REJECTED — must live under metadata.version

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = join(fileURLToPath(import.meta.url), "..", "..", "skills");
const KEBAB = /^[a-z][a-z0-9-]*$/;

// Parse a `---`-fenced frontmatter block into a one-level nested map.
// Supports `key: value`, nested `metadata:` with indented scalar children,
// and quoted scalars (strips surrounding quotes). Returns {obj, errors}.
function parseFrontmatter(text: string): { obj: Record<string, unknown>; errors: string[] } {
	const errors: string[] = [];
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") {
		return { obj: {}, errors: ["missing leading `---` frontmatter fence"] };
	}
	let i = 1;
	const raw: { key: string; val: string; indent: number }[] = [];
	while (i < lines.length && lines[i].trim() !== "---") {
		const line = lines[i];
		if (line.trim() !== "") {
			const indent = line.length - line.trimStart().length;
			const m = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
			if (m) raw.push({ key: m[2], val: m[3] ?? "", indent });
			else errors.push(`unparsable frontmatter line: ${JSON.stringify(line)}`);
		}
		i += 1;
	}
	if (i >= lines.length) {
		return { obj: {}, errors: [...errors, "missing closing `---` frontmatter fence"] };
	}
	const obj: Record<string, unknown> = {};
	const unquote = (s: string) => {
		if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
			return s.slice(1, -1);
		}
		return s;
	};
	let j = 0;
	while (j < raw.length) {
		const { key, val, indent } = raw[j];
		if (indent !== 0) {
			errors.push(`unexpected indented top-level key \`${key}\``);
			j += 1;
			continue;
		}
		if (val === "") {
			// nested block (only `metadata` supported)
			if (key === "metadata") {
				const meta: Record<string, string> = {};
				j += 1;
				while (j < raw.length && raw[j].indent > 0) {
					const cv = unquote(raw[j].val);
					if (cv === "") errors.push(`metadata.${raw[j].key} must be a non-empty string`);
					else meta[raw[j].key] = cv;
					j += 1;
				}
				obj[key] = meta;
			} else {
				errors.push(`nested block under \`${key}\` not supported`);
				j += 1;
				while (j < raw.length && raw[j].indent > 0) j += 1;
			}
			continue;
		}
		obj[key] = unquote(val);
		j += 1;
	}
	return { obj, errors };
}

function validate(dirName: string): string[] {
	const errors: string[] = [];
	const file = join(SKILLS_DIR, dirName, "SKILL.md");
	if (!existsSync(file)) {
		return [`missing ${dirName}/SKILL.md`];
	}
	const text = readFileSync(file, "utf8");
	const { obj, errors: parseErrors } = parseFrontmatter(text);
	errors.push(...parseErrors);

	if ("version" in obj) {
		errors.push("top-level `version` is forbidden; move it under `metadata.version`");
	}

	const name = obj.name;
	if (typeof name !== "string" || name === "") {
		errors.push("`name` is required and must be a non-empty string");
	} else {
		if (!KEBAB.test(name)) errors.push(`\`name\` must be kebab-case (got "${name}")`);
		if (name !== dirName) {
			errors.push(`\`name\` ("${name}") must equal directory name ("${dirName}")`);
		}
	}

	const desc = obj.description;
	if (typeof desc !== "string" || desc === "") {
		errors.push("`description` is required and must be a non-empty string");
	} else if (desc.length > 1024) {
		errors.push(`\`description\` length ${desc.length} exceeds 1024 chars`);
	}

	const meta = obj.metadata;
	if (meta !== undefined) {
		if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
			errors.push("`metadata` must be a mapping of string keys to string values");
		} else {
			for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
				if (typeof v !== "string") errors.push(`\`metadata.${k}\` must be a string`);
			}
		}
	}

	return errors;
}

function main(): number {
	if (!existsSync(SKILLS_DIR)) {
		console.error(`skills directory not found: ${SKILLS_DIR}`);
		return 1;
	}
	const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();
	let total = 0;
	let bad = 0;
	for (const dir of dirs) {
		total += 1;
		const errs = validate(dir);
		if (errs.length === 0) {
			console.log(`  ok  ${dir}/SKILL.md`);
		} else {
			bad += 1;
			console.error(`FAIL  ${dir}/SKILL.md`);
			for (const e of errs) console.error(`      - ${e}`);
		}
	}
	console.log(`\n${total - bad}/${total} skills valid`);
	return bad === 0 ? 0 : 1;
}

process.exit(main());

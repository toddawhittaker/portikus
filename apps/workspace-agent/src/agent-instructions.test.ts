/**
 * The instruction files are copied once and never overwritten (SPEC.md §4.4).
 */
import {
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	CLAUDE_IMPORT_LINE,
	CLAUDE_INSTRUCTIONS,
	CODEX_INSTRUCTIONS,
	seedAgentInstructions,
} from "./agent-instructions.js";

const TEMPLATE_TEXT = "# Working in a Portikus workspace\n";

let root: string;
let home: string;
let template: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "portikus-agent-instructions-"));
	home = join(root, "home");
	await mkdir(home);
	template = join(root, "AGENTS.md");
	await writeFile(template, TEMPLATE_TEXT);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("seedAgentInstructions", () => {
	test("a fresh home gets the template and the Claude import", async () => {
		const created = await seedAgentInstructions(home, template);
		expect(created).toEqual([CODEX_INSTRUCTIONS, CLAUDE_INSTRUCTIONS]);
		expect(await readFile(join(home, CODEX_INSTRUCTIONS), "utf8")).toBe(TEMPLATE_TEXT);
		expect(await readFile(join(home, CLAUDE_INSTRUCTIONS), "utf8")).toBe(
			"@~/.codex/AGENTS.md\n",
		);
		expect((await stat(join(home, ".codex"))).mode & 0o777).toBe(0o700);
		expect((await stat(join(home, ".claude"))).mode & 0o777).toBe(0o700);
	});

	test("edited files are never overwritten, even after the template changes", async () => {
		await seedAgentInstructions(home, template);
		await writeFile(join(home, CODEX_INSTRUCTIONS), "my own rules\n");
		await writeFile(
			join(home, CLAUDE_INSTRUCTIONS),
			"@~/.codex/AGENTS.md\nmore rules\n",
		);
		await writeFile(template, "a newer template\n");

		expect(await seedAgentInstructions(home, template)).toEqual([]);
		expect(await readFile(join(home, CODEX_INSTRUCTIONS), "utf8")).toBe(
			"my own rules\n",
		);
		expect(await readFile(join(home, CLAUDE_INSTRUCTIONS), "utf8")).toBe(
			"@~/.codex/AGENTS.md\nmore rules\n",
		);
	});

	test("a student's own CLAUDE.md is kept while the Codex file is added", async () => {
		await mkdir(join(home, ".claude"));
		await writeFile(join(home, CLAUDE_INSTRUCTIONS), "student's rules\n");

		expect(await seedAgentInstructions(home, template)).toEqual([CODEX_INSTRUCTIONS]);
		expect(await readFile(join(home, CLAUDE_INSTRUCTIONS), "utf8")).toBe(
			"student's rules\n",
		);
		expect(await readFile(join(home, CODEX_INSTRUCTIONS), "utf8")).toBe(TEMPLATE_TEXT);
	});

	test("a student's own AGENTS.md is kept while the Claude import is added", async () => {
		await mkdir(join(home, ".codex"));
		await writeFile(join(home, CODEX_INSTRUCTIONS), "student's rules\n");

		expect(await seedAgentInstructions(home, template)).toEqual([CLAUDE_INSTRUCTIONS]);
		expect(await readFile(join(home, CODEX_INSTRUCTIONS), "utf8")).toBe(
			"student's rules\n",
		);
		expect(await readFile(join(home, CLAUDE_INSTRUCTIONS), "utf8")).toBe(
			CLAUDE_IMPORT_LINE,
		);
	});

	test("a symbolic link at either path is left alone, not followed", async () => {
		const target = join(root, "elsewhere");
		await mkdir(join(home, ".codex"));
		await mkdir(join(home, ".claude"));
		await symlink(target, join(home, CODEX_INSTRUCTIONS));
		await symlink(target, join(home, CLAUDE_INSTRUCTIONS));

		expect(await seedAgentInstructions(home, template)).toEqual([]);
		expect(await readlink(join(home, CODEX_INSTRUCTIONS))).toBe(target);
		await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("an image without the template gets neither file", async () => {
		expect(await seedAgentInstructions(home, join(root, "missing.md"))).toEqual([]);
		await expect(stat(join(home, CODEX_INSTRUCTIONS))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(stat(join(home, CLAUDE_INSTRUCTIONS))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	test("an unexpected error is thrown for the caller to log", async () => {
		// A file where the .claude folder should be makes mkdir fail.
		await writeFile(join(home, ".claude"), "not a folder");
		await expect(seedAgentInstructions(home, template)).rejects.toMatchObject({
			code: "EEXIST",
		});
	});
});

/**
 * The home's instruction files belong to the student; only the platform's
 * own leftovers are removed (SPEC.md §3).
 */
import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	CLAUDE_INSTRUCTIONS,
	CODEX_INSTRUCTIONS,
	returnHomeInstructions,
} from "./agent-instructions.js";

let root: string;
let home: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "portikus-agent-instructions-"));
	home = join(root, "home");
	await mkdir(join(home, ".codex"), { recursive: true });
	await mkdir(join(home, ".claude"), { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
	return lstat(path).then(
		() => true,
		() => false,
	);
}

describe("returnHomeInstructions", () => {
	test("an empty home is left alone", async () => {
		await rm(join(home, ".codex"), { recursive: true });
		expect(await returnHomeInstructions(home)).toEqual([]);
		expect(await exists(join(home, ".codex"))).toBe(false);
	});

	test("a Claude file holding only the import line is removed", async () => {
		await writeFile(join(home, CLAUDE_INSTRUCTIONS), "@~/.codex/AGENTS.md\n");
		expect(await returnHomeInstructions(home)).toEqual([CLAUDE_INSTRUCTIONS]);
		expect(await exists(join(home, CLAUDE_INSTRUCTIONS))).toBe(false);
	});

	test("only the exact import line goes; the student's lines stay", async () => {
		await writeFile(
			join(home, CLAUDE_INSTRUCTIONS),
			"@~/.codex/AGENTS.md\nmy rule\n  @~/.codex/AGENTS.md\n@~/.codex/AGENTS.md extra\n",
		);
		await returnHomeInstructions(home);
		expect(await readFile(join(home, CLAUDE_INSTRUCTIONS), "utf8")).toBe(
			"my rule\n  @~/.codex/AGENTS.md\n@~/.codex/AGENTS.md extra\n",
		);
	});

	test("a Claude file without the import line is untouched", async () => {
		await writeFile(join(home, CLAUDE_INSTRUCTIONS), "only mine\n");
		expect(await returnHomeInstructions(home)).toEqual([]);
		expect(await readFile(join(home, CLAUDE_INSTRUCTIONS), "utf8")).toBe("only mine\n");
	});

	test("an unchanged copy of a past template is removed", async () => {
		const text = "old platform template\n";
		const hash = createHash("sha256").update(text).digest("hex");
		await writeFile(join(home, CODEX_INSTRUCTIONS), text);
		expect(await returnHomeInstructions(home, [hash])).toEqual([CODEX_INSTRUCTIONS]);
		expect(await exists(join(home, CODEX_INSTRUCTIONS))).toBe(false);
	});

	test("an edited Codex file survives", async () => {
		await writeFile(join(home, CODEX_INSTRUCTIONS), "student's AGENTS.md\n");
		expect(await returnHomeInstructions(home)).toEqual([]);
		expect(await readFile(join(home, CODEX_INSTRUCTIONS), "utf8")).toBe(
			"student's AGENTS.md\n",
		);
	});

	test("the import line goes with a removed past-template Codex copy", async () => {
		const text = "old platform template\n";
		const hash = createHash("sha256").update(text).digest("hex");
		await writeFile(join(home, CODEX_INSTRUCTIONS), text);
		await writeFile(join(home, CLAUDE_INSTRUCTIONS), "@~/.codex/AGENTS.md\nmine\n");
		expect(await returnHomeInstructions(home, [hash])).toEqual([
			CODEX_INSTRUCTIONS,
			CLAUDE_INSTRUCTIONS,
		]);
		expect(await readFile(join(home, CLAUDE_INSTRUCTIONS), "utf8")).toBe("mine\n");
	});

	test("the import line stays while the student's edited Codex file is kept", async () => {
		await writeFile(join(home, CODEX_INSTRUCTIONS), "student's AGENTS.md\n");
		await writeFile(join(home, CLAUDE_INSTRUCTIONS), "@~/.codex/AGENTS.md\nmine\n");
		expect(await returnHomeInstructions(home)).toEqual([]);
		expect(await readFile(join(home, CLAUDE_INSTRUCTIONS), "utf8")).toBe(
			"@~/.codex/AGENTS.md\nmine\n",
		);
	});

	test("symbolic links are never followed or replaced", async () => {
		const target = join(root, "elsewhere.md");
		await writeFile(target, "@~/.codex/AGENTS.md\n");
		await symlink(target, join(home, CLAUDE_INSTRUCTIONS));
		await symlink(target, join(home, CODEX_INSTRUCTIONS));
		expect(await returnHomeInstructions(home)).toEqual([]);
		expect(await readlink(join(home, CLAUDE_INSTRUCTIONS))).toBe(target);
		expect(await readlink(join(home, CODEX_INSTRUCTIONS))).toBe(target);
		expect(await readFile(target, "utf8")).toBe("@~/.codex/AGENTS.md\n");
	});
});

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	PORTIKUS_IGNORE_LINES,
	readHandoffNote,
	rewriteHandoffNote,
	writeHandoffNote,
} from "./project-files.js";

/** Handoff notes saved under `.portikus/handoffs/` (SPEC.md §7.2, §10.8). */

let project: string;
const NOW = new Date("2026-11-14T10:20:30.123Z");

beforeEach(async () => {
	project = await mkdtemp(join(tmpdir(), "pk-handoff-"));
});

afterEach(async () => {
	await rm(project, { recursive: true, force: true });
});

describe("handoff notes", () => {
	test("a note is saved under a UTC name, and the ignore lines go into a Git project's exclude", async () => {
		await mkdir(join(project, ".git", "info"), { recursive: true });
		const path = await writeHandoffNote(project, "## Goal\n", NOW);
		expect(path).toBe(".portikus/handoffs/2026-11-14T10-20-30Z.md");
		await expect(readFile(join(project, path), "utf8")).resolves.toBe("## Goal\n");
		const exclude = await readFile(join(project, ".git", "info", "exclude"), "utf8");
		expect(exclude).toBe(`${PORTIKUS_IGNORE_LINES.join("\n")}\n`);
	});

	test("a second note in the same second gets its own name, never replacing the first", async () => {
		const first = await writeHandoffNote(project, "one", NOW);
		const second = await writeHandoffNote(project, "two", NOW);
		expect(second).toBe(".portikus/handoffs/2026-11-14T10-20-30Z-1.md");
		await expect(readHandoffNote(project, first)).resolves.toBe("one");
		await expect(readHandoffNote(project, second)).resolves.toBe("two");
	});

	test("an edit rewrites the note", async () => {
		const path = await writeHandoffNote(project, "long first draft", NOW);
		await rewriteHandoffNote(project, path, "short");
		await expect(readHandoffNote(project, path)).resolves.toBe("short");
	});

	test("a symlinked .portikus or note is never written through", async () => {
		const outside = await mkdtemp(join(tmpdir(), "pk-outside-"));
		try {
			await symlink(outside, join(project, ".portikus"));
			await expect(writeHandoffNote(project, "x", NOW)).rejects.toThrow();
			await rm(join(project, ".portikus"));
			const path = await writeHandoffNote(project, "x", NOW);
			const target = join(outside, "target.md");
			await writeFile(target, "kept");
			await rm(join(project, path));
			await symlink(target, join(project, path));
			await expect(rewriteHandoffNote(project, path, "y")).rejects.toThrow();
			await expect(readHandoffNote(project, path)).rejects.toThrow();
			await expect(readFile(target, "utf8")).resolves.toBe("kept");
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

describe("a handoff note path is checked before it is read or written", () => {
	test.each([
		"../../.codex/auth.json",
		".portikus/handoffs/../../.codex/auth.json",
		"/etc/passwd",
		".portikus/other.md",
		"README.md",
	])("%s is refused", async (path) => {
		await mkdir(join(project, ".portikus", "handoffs"), { recursive: true });
		await mkdir(join(project, ".codex"), { recursive: true });
		await writeFile(join(project, ".codex", "auth.json"), "secret");
		await writeFile(join(project, "README.md"), "readme");
		await expect(readHandoffNote(project, path)).rejects.toThrow(
			"not a handoff note path",
		);
		await expect(rewriteHandoffNote(project, path, "x")).rejects.toThrow(
			"not a handoff note path",
		);
		await expect(readFile(join(project, ".codex", "auth.json"), "utf8")).resolves.toBe(
			"secret",
		);
	});

	test("a symlinked handoffs directory is not read through", async () => {
		const outside = await mkdtemp(join(tmpdir(), "pk-outside-"));
		try {
			await mkdir(join(project, ".portikus"));
			await writeFile(join(outside, "2026-11-14T10-20-30Z.md"), "elsewhere");
			await symlink(outside, join(project, ".portikus", "handoffs"));
			await expect(
				readHandoffNote(project, ".portikus/handoffs/2026-11-14T10-20-30Z.md"),
			).rejects.toThrow();
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GitResult } from "./git-runner.js";

const gitResult = vi.hoisted(() => ({ value: undefined as GitResult | undefined }));

vi.mock("./git-runner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./git-runner.js")>();
	return { ...actual, runGit: async () => gitResult.value };
});

const { createProject, gitInitProject, projectsDir } = await import("./projects.js");

let homeDir: string;

beforeEach(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-git-error-"));
	await mkdir(join(projectsDir(homeDir), "demo"), { recursive: true });
});

afterEach(async () => {
	await rm(homeDir, { recursive: true, force: true });
});

function failed(stderr: string): GitResult {
	return {
		ok: false,
		stdout: Buffer.alloc(0),
		stderr,
		overflow: false,
		timedOut: false,
		exitCode: 128,
	};
}

test("a git failure's message is its stderr without the trailing newline", async () => {
	gitResult.value = failed("fatal: something broke\n");
	await expect(gitInitProject("demo", homeDir)).rejects.toMatchObject({
		code: "GIT_FAILED",
		message: "fatal: something broke",
	});
});

test("a newline-only stderr falls back to the exit status", async () => {
	gitResult.value = failed("\n");
	await expect(gitInitProject("demo", homeDir)).rejects.toMatchObject({
		code: "GIT_FAILED",
		message: "git exited with status 128",
	});
});

test("git reporting a full disk answers STORAGE_FULL, not GIT_FAILED", async () => {
	// SPEC.md §27: the student must be told storage is the cause.
	gitResult.value = failed("error: unable to write file: No space left on device\n");
	await expect(gitInitProject("demo", homeDir)).rejects.toMatchObject({
		code: "STORAGE_FULL",
	});
});

test("a clone on a full disk answers STORAGE_FULL and leaves no folder", async () => {
	gitResult.value = failed("fatal: write error: No space left on device\n");
	await expect(
		createProject(
			{
				slug: "cloned",
				source: "clone",
				url: "https://example.com/a/b.git",
				gitInit: true,
			},
			homeDir,
		),
	).rejects.toMatchObject({ code: "STORAGE_FULL" });
	expect(await readdir(projectsDir(homeDir))).toEqual(["demo"]);
});

test("a template on an over-quota disk answers STORAGE_FULL", async () => {
	gitResult.value = failed("fatal: Disk quota exceeded\n");
	await expect(
		createProject(
			{
				slug: "tmpl",
				source: "template",
				url: "https://example.com/a/t.git",
				gitInit: true,
			},
			homeDir,
		),
	).rejects.toMatchObject({ code: "STORAGE_FULL" });
});

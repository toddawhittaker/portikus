import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GitResult } from "./git-runner.js";

const gitResult = vi.hoisted(() => ({ value: undefined as GitResult | undefined }));

vi.mock("./git-runner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./git-runner.js")>();
	return { ...actual, runGit: async () => gitResult.value };
});

const { gitInitProject, projectsDir } = await import("./projects.js");

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

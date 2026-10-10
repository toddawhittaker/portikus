/**
 * A `git cat-file` that never answers must not read as "the ref lacks this
 * file": that would show the whole file as added (SPEC.md §12.6).
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { GitResult } from "./git-runner.js";

const catFile = vi.hoisted(() => ({ value: undefined as GitResult | undefined }));

vi.mock("./git-runner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./git-runner.js")>();
	return {
		...actual,
		runGit: (...args: Parameters<typeof actual.runGit>) =>
			args[0][0] === "cat-file" && catFile.value
				? Promise.resolve(catFile.value)
				: actual.runGit(...args),
	};
});

const { refDiff } = await import("./git-compare.js");

const execFileAsync = promisify(execFile);
const GIT_ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

let homeDir: string;

beforeAll(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-compare-timeout-"));
	const project = join(homeDir, "projects", "demo");
	await mkdir(project, { recursive: true });
	const env = { ...process.env, ...GIT_ENV };
	await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: project, env });
	await writeFile(join(project, "a.txt"), "first\n");
	await execFileAsync("git", ["add", "a.txt"], { cwd: project, env });
	await execFileAsync("git", ["commit", "-m", "first"], { cwd: project, env });
});

afterAll(async () => {
	await rm(homeDir, { recursive: true, force: true });
});

function killed(timedOut: boolean): GitResult {
	return {
		ok: false,
		stdout: Buffer.alloc(0),
		stderr: "",
		overflow: false,
		timedOut,
		exitCode: null,
	};
}

test("a timed-out or killed type check is a Git failure, not a missing file", async () => {
	for (const result of [killed(true), killed(false)]) {
		catFile.value = result;
		await expect(refDiff(homeDir, "demo", "a.txt", "HEAD")).rejects.toMatchObject({
			code: "GIT_FAILED",
		});
	}
});

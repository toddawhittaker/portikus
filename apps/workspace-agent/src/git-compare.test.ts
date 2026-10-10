/**
 * Comparing one file's working copy with a Git ref (SPEC.md §12.6). The ref
 * is typed by the student, so most of these tests are about what it must
 * never be able to do: read as an option, name a range, or move anything
 * (SPEC.md §12.5, §24.6).
 */
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { AgentFailure } from "./errors.js";
import { refDiff } from "./git-compare.js";
import { buildServer } from "./server.js";

const execFileAsync = promisify(execFile);
const TOKEN = "c".repeat(64);
const SLUG = "compare";

/** A committer identity, so commits work on a bare CI runner. */
const GIT_ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
	GIT_CONFIG_COUNT: "1",
	GIT_CONFIG_KEY_0: "maintenance.auto",
	GIT_CONFIG_VALUE_0: "false",
};

let app: FastifyInstance;
let homeDir: string;
let project: string;
let firstCommit: string;

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		env: { ...process.env, ...GIT_ENV },
	});
	return stdout;
}

async function commitAll(message: string): Promise<void> {
	await git(["add", "-A"], project);
	await git(["commit", "-m", message], project);
}

async function refusal(ref: string): Promise<AgentFailure> {
	const failure = await refDiff(homeDir, SLUG, "a.txt", ref).catch(
		(error: unknown) => error,
	);
	expect(failure).toBeInstanceOf(AgentFailure);
	return failure as AgentFailure;
}

beforeAll(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-compare-"));
	const tokenPath = join(homeDir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	app = buildServer({ tmuxSocketName: "portikus-test", tokenPath, homeDir });
	await app.ready();
});

afterAll(async () => {
	await app.close();
	await rm(homeDir, { recursive: true, force: true });
});

beforeEach(async () => {
	await rm(join(homeDir, "projects"), { recursive: true, force: true, maxRetries: 5 });
	project = join(homeDir, "projects", SLUG);
	await mkdir(project, { recursive: true });
	await git(["init", "--initial-branch=main"], project);
	await writeFile(join(project, "a.txt"), "first\n");
	await commitAll("first");
	firstCommit = (await git(["rev-parse", "HEAD"], project)).trim();
	await git(["branch", "old"], project);
	await git(["tag", "v1"], project);
	await writeFile(join(project, "a.txt"), "second\n");
	await writeFile(join(project, "b.txt"), "new\n");
	await commitAll("second");
	await writeFile(join(project, "a.txt"), "working\n");
});

test("a branch, a tag, a short id and a relative ref all name the old version", async () => {
	for (const ref of ["old", "v1", firstCommit.slice(0, 7), "HEAD~1", firstCommit]) {
		const diff = await refDiff(homeDir, SLUG, "a.txt", ref);
		expect(diff).toMatchObject({ status: "M", before: "first\n", after: "working\n" });
	}
});

test("a file the ref does not have reads as added", async () => {
	const diff = await refDiff(homeDir, SLUG, "b.txt", "old");
	expect(diff).toMatchObject({ status: "A", before: null, after: "new\n" });
});

test("a file gone from the working tree reads as deleted", async () => {
	await rm(join(project, "a.txt"));
	const diff = await refDiff(homeDir, SLUG, "a.txt", "old");
	expect(diff).toMatchObject({ status: "D", before: "first\n", after: null });
});

test("a ref that names no commit is the student's mistake", async () => {
	for (const ref of ["nope", "HEAD^{tree}", "HEAD:a.txt", "old~99"]) {
		const failure = await refusal(ref);
		expect(failure.code).toBe("BAD_REQUEST");
		expect(failure.message).toBe("That Git ref does not name a commit.");
	}
});

test("a ref that could read as an option, a range, or a second line is refused", async () => {
	const marker = join(homeDir, "written-by-git");
	const hostile = [
		`--output=${marker}`,
		"-h",
		"--end-of-options",
		"old..main",
		"main...old",
		"../../etc",
		"main\nHEAD",
		"main\0x",
		"x".repeat(257),
		"",
	];
	// The route validates the ref once, before refDiff sees it.
	for (const ref of hostile) {
		const denied = await app.inject({
			method: "GET",
			url: `/projects/${SLUG}/git/diff?path=a.txt&ref=${encodeURIComponent(ref)}`,
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(denied.statusCode).toBe(400);
		expect(denied.json().error.code).toBe("BAD_REQUEST");
	}
	await expect(access(marker)).rejects.toThrow();
});

test("comparing moves nothing: HEAD, branches and the work tree stay as they were", async () => {
	const before = await git(
		["for-each-ref", "--format=%(refname) %(objectname)"],
		project,
	);
	const head = await git(["rev-parse", "HEAD"], project);
	const status = await git(["status", "--porcelain=v2", "--branch"], project);
	await refDiff(homeDir, SLUG, "a.txt", "old");
	expect(
		await git(["for-each-ref", "--format=%(refname) %(objectname)"], project),
	).toBe(before);
	expect(await git(["rev-parse", "HEAD"], project)).toBe(head);
	expect(await git(["status", "--porcelain=v2", "--branch"], project)).toBe(status);
});

test("a project that is not a repository cannot be compared with a ref", async () => {
	await rm(join(project, ".git"), { recursive: true, force: true });
	expect((await refusal("old")).code).toBe("BAD_REQUEST");
});

test("the diff route takes a ref and refuses a hostile one", async () => {
	const headers = { authorization: `Bearer ${TOKEN}` };
	const ok = await app.inject({
		method: "GET",
		url: `/projects/${SLUG}/git/diff?path=a.txt&ref=old`,
		headers,
	});
	expect(ok.statusCode).toBe(200);
	expect(ok.json()).toMatchObject({ before: "first\n", after: "working\n" });

	for (const ref of ["-h", "old..main", "a\u0007b"]) {
		const denied = await app.inject({
			method: "GET",
			url: `/projects/${SLUG}/git/diff?path=a.txt&ref=${encodeURIComponent(ref)}`,
			headers,
		});
		expect(denied.statusCode).toBe(400);
		expect(denied.json().error.code).toBe("BAD_REQUEST");
	}
});

test("without a ref the route still compares with HEAD", async () => {
	const response = await app.inject({
		method: "GET",
		url: `/projects/${SLUG}/git/diff?path=a.txt`,
		headers: { authorization: `Bearer ${TOKEN}` },
	});
	expect(response.json()).toMatchObject({ before: "second\n", after: "working\n" });
});

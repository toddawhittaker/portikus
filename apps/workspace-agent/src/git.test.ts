import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MAX_DIFF_SIDE_BYTES, MAX_GIT_ENTRIES } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { gitDiff, gitStatus, parsePorcelainV2, showFromHead } from "./git.js";
import { buildServer } from "./server.js";

const execFileAsync = promisify(execFile);

const TOKEN = "a".repeat(64);
const SLUG = "alpha";

/** A committer identity, so commits work on a bare CI runner. */
const GIT_ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

let app: FastifyInstance;
let homeDir: string;
let projectsRoot: string;
let project: string;

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		env: { ...process.env, ...GIT_ENV },
	});
	return stdout;
}

async function initRepo(dir: string): Promise<void> {
	await git(["init", "--initial-branch=main"], dir);
}

async function commitAll(dir: string, message: string): Promise<void> {
	await git(["add", "-A"], dir);
	await git(["commit", "-m", message], dir);
}

function auth() {
	return { authorization: `Bearer ${TOKEN}` };
}

beforeAll(async () => {
	Object.assign(process.env, GIT_ENV);
	homeDir = await mkdtemp(join(tmpdir(), "portikus-git-"));
	projectsRoot = join(homeDir, "projects");
	const tokenPath = join(homeDir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	app = buildServer({ tokenPath, homeDir });
	await app.ready();
});

afterAll(async () => {
	await app.close();
	await rm(homeDir, { recursive: true, force: true });
});

beforeEach(async () => {
	await rm(projectsRoot, { recursive: true, force: true });
	project = join(projectsRoot, SLUG);
	await mkdir(project, { recursive: true });
});

test("the parser reads every record kind, including paths with spaces", () => {
	const text = [
		"# branch.oid abc123",
		"# branch.head main",
		"# branch.upstream origin/main",
		"# branch.ab +2 -3",
		"1 .M N... 100644 100644 100644 aaa bbb src/my file.ts",
		"2 R. N... 100644 100644 100644 ccc ddd R100 new name.ts",
		"old name.ts",
		"u UU N... 100644 100644 100644 100644 e1 e2 e3 conflict.ts",
		"? untracked.txt",
		"! ignored.log",
	].join("\0");

	const status = parsePorcelainV2(text);
	expect(status.repo).toBe(true);
	expect(status.branch).toBe("main");
	expect(status.detached).toBe(false);
	expect(status.upstream).toBe("origin/main");
	expect(status.ahead).toBe(2);
	expect(status.behind).toBe(3);
	expect(status.conflicts).toBe(1);
	expect(status.ignored).toEqual(["ignored.log"]);
	expect(status.entries).toEqual([
		{ path: "src/my file.ts", x: ".", y: "M", unmerged: false },
		{
			path: "new name.ts",
			x: "R",
			y: ".",
			unmerged: false,
			origPath: "old name.ts",
		},
		{ path: "conflict.ts", x: "U", y: "U", unmerged: true },
		{ path: "untracked.txt", x: "?", y: "?", unmerged: false },
	]);
	expect(status.truncated).toBe(false);
});

test("a both-added record is a conflict as much as a both-modified one", () => {
	const text = [
		"# branch.head main",
		"u AA N... 100644 100644 100644 100644 e1 e2 e3 both-added.ts",
		"u DD N... 100644 100644 100644 100644 f1 f2 f3 both-deleted.ts",
		"",
	].join("\0");

	const status = parsePorcelainV2(text);
	expect(status.conflicts).toBe(2);
	expect(status.entries).toEqual([
		{ path: "both-added.ts", x: "A", y: "A", unmerged: true },
		{ path: "both-deleted.ts", x: "D", y: "D", unmerged: true },
	]);
});

test("a detached head has no branch name", () => {
	const status = parsePorcelainV2(["# branch.head (detached)", ""].join("\0"));
	expect(status.detached).toBe(true);
	expect(status.branch).toBeNull();
});

test("the entry list is capped and says so", () => {
	const records: string[] = [];
	for (let i = 0; i < 5100; i += 1) {
		records.push(`? file-${i}.txt`);
	}
	const status = parsePorcelainV2(records.join("\0"));
	expect(status.entries).toHaveLength(5000);
	expect(status.truncated).toBe(true);
});

test("ignored paths share the entry cap", () => {
	const records: string[] = [];
	for (let i = 0; i < 100; i += 1) records.push(`? file-${i}.txt`);
	for (let i = 0; i < MAX_GIT_ENTRIES; i += 1) records.push(`! noise-${i}.log`);

	const status = parsePorcelainV2(records.join("\0"));
	expect(status.entries).toHaveLength(100);
	expect(status.ignored).toHaveLength(MAX_GIT_ENTRIES - 100);
	expect(status.truncated).toBe(true);
});

test("a project that is not a repository reports repo false", async () => {
	const status = await gitStatus(homeDir, SLUG, { hidden: false });
	expect(status).toEqual({
		repo: false,
		branch: null,
		detached: false,
		upstream: null,
		ahead: 0,
		behind: 0,
		conflicts: 0,
		entries: [],
		ignored: [],
		truncated: false,
	});
});

test("a repository with no commits lists untracked files and adds them", async () => {
	await initRepo(project);
	await writeFile(join(project, "new.txt"), "hello\n");

	const status = await gitStatus(homeDir, SLUG, { hidden: false });
	expect(status.repo).toBe(true);
	expect(status.branch).toBe("main");
	expect(status.entries).toEqual([
		{ path: "new.txt", x: "?", y: "?", unmerged: false },
	]);
	expect(status.upstream).toBeNull();

	const diff = await gitDiff(homeDir, SLUG, "new.txt");
	expect(diff.status).toBe("A");
	expect(diff.before).toBeNull();
	expect(diff.after).toBe("hello\n");
});

test("a modified tracked file diffs HEAD against the working tree", async () => {
	await initRepo(project);
	await writeFile(join(project, "a.txt"), "one\n");
	await commitAll(project, "first");
	await writeFile(join(project, "a.txt"), "two\n");

	const status = await gitStatus(homeDir, SLUG, { hidden: false });
	expect(status.entries).toEqual([{ path: "a.txt", x: ".", y: "M", unmerged: false }]);

	const diff = await gitDiff(homeDir, SLUG, "a.txt");
	expect(diff.status).toBe("M");
	expect(diff.before).toBe("one\n");
	expect(diff.after).toBe("two\n");
	expect(diff.binary).toBe(false);
	expect(diff.tooLarge).toBe(false);
});

test("a deleted tracked file shows the HEAD version only", async () => {
	await initRepo(project);
	await writeFile(join(project, "a.txt"), "one\n");
	await commitAll(project, "first");
	await rm(join(project, "a.txt"));

	const status = await gitStatus(homeDir, SLUG, { hidden: false });
	expect(status.entries[0]?.y).toBe("D");

	const diff = await gitDiff(homeDir, SLUG, "a.txt");
	expect(diff.status).toBe("D");
	expect(diff.before).toBe("one\n");
	expect(diff.after).toBeNull();
});

test("a rename carries the old path and reads before from it", async () => {
	await initRepo(project);
	await writeFile(join(project, "old.txt"), "same\n");
	await commitAll(project, "first");
	await git(["mv", "old.txt", "new.txt"], project);

	const status = await gitStatus(homeDir, SLUG, { hidden: false });
	expect(status.entries[0]?.path).toBe("new.txt");
	expect(status.entries[0]?.origPath).toBe("old.txt");

	const diff = await gitDiff(homeDir, SLUG, "new.txt");
	expect(diff.status).toBe("R");
	expect(diff.oldPath).toBe("old.txt");
	expect(diff.before).toBe("same\n");
	expect(diff.after).toBe("same\n");
});

test("an unresolved merge conflict is counted and diffs as U", async () => {
	await initRepo(project);
	await writeFile(join(project, "a.txt"), "base\n");
	await commitAll(project, "base");
	await git(["checkout", "-b", "other"], project);
	await writeFile(join(project, "a.txt"), "theirs\n");
	await commitAll(project, "theirs");
	await git(["checkout", "main"], project);
	await writeFile(join(project, "a.txt"), "ours\n");
	await commitAll(project, "ours");
	await expect(git(["merge", "other"], project)).rejects.toThrow();

	const status = await gitStatus(homeDir, SLUG, { hidden: false });
	expect(status.conflicts).toBe(1);

	const diff = await gitDiff(homeDir, SLUG, "a.txt");
	expect(diff.status).toBe("U");
});

test("ahead and behind are reported against an upstream", async () => {
	await initRepo(project);
	await writeFile(join(project, "a.txt"), "one\n");
	await commitAll(project, "first");
	const bare = join(homeDir, "remote.git");
	await git(["init", "--bare", bare], homeDir);
	await git(["remote", "add", "origin", bare], project);
	await git(["push", "-u", "origin", "main"], project);

	// A second clone moves the remote forward, so the project is behind.
	const other = join(homeDir, "clone");
	await git(["clone", bare, other], homeDir);
	await writeFile(join(other, "b.txt"), "remote\n");
	await commitAll(other, "remote side");
	await git(["push"], other);

	// And a local commit puts it ahead as well.
	await writeFile(join(project, "c.txt"), "local\n");
	await commitAll(project, "local side");
	await git(["fetch"], project);

	const status = await gitStatus(homeDir, SLUG, { hidden: false });
	expect(status.upstream).toBe("origin/main");
	expect(status.ahead).toBe(1);
	expect(status.behind).toBe(1);

	await rm(other, { recursive: true, force: true });
	await rm(bare, { recursive: true, force: true });
});

test("a detached HEAD reports no branch", async () => {
	await initRepo(project);
	await writeFile(join(project, "a.txt"), "one\n");
	await commitAll(project, "first");
	const head = (await git(["rev-parse", "HEAD"], project)).trim();
	await git(["checkout", head], project);

	const status = await gitStatus(homeDir, SLUG, { hidden: false });
	expect(status.detached).toBe(true);
	expect(status.branch).toBeNull();
});

test("ignored files appear only when hidden files are shown", async () => {
	await initRepo(project);
	await writeFile(join(project, ".gitignore"), "secret.log\n");
	await writeFile(join(project, "secret.log"), "noise\n");

	const plain = await gitStatus(homeDir, SLUG, { hidden: false });
	expect(plain.ignored).toEqual([]);
	expect(plain.entries.map((entry) => entry.path)).not.toContain("secret.log");

	const hidden = await gitStatus(homeDir, SLUG, { hidden: true });
	expect(hidden.ignored).toContain("secret.log");
	expect(hidden.entries.map((entry) => entry.path)).not.toContain("secret.log");
});

test("binary content is reported without either side", async () => {
	await initRepo(project);
	await writeFile(join(project, "logo.bin"), Buffer.from([0, 1, 2, 3, 0]));
	await commitAll(project, "first");
	await writeFile(join(project, "logo.bin"), Buffer.from([0, 9, 9, 9, 0]));

	const diff = await gitDiff(homeDir, SLUG, "logo.bin");
	expect(diff.binary).toBe(true);
	expect(diff.before).toBeNull();
	expect(diff.after).toBeNull();
	expect(diff.tooLarge).toBe(false);
});

test("an oversized side is reported as too large rather than sent", async () => {
	await initRepo(project);
	await writeFile(join(project, "big.txt"), "x".repeat(MAX_DIFF_SIDE_BYTES + 1));

	const diff = await gitDiff(homeDir, SLUG, "big.txt");
	expect(diff.tooLarge).toBe(true);
	expect(diff.before).toBeNull();
	expect(diff.after).toBeNull();
});

test("an oversized HEAD side is capped while git is still writing it", async () => {
	await initRepo(project);
	await writeFile(join(project, "big.txt"), "x".repeat(MAX_DIFF_SIDE_BYTES + 1024));
	await commitAll(project, "first");
	await rm(join(project, "big.txt"));

	const diff = await gitDiff(homeDir, SLUG, "big.txt");
	expect(diff.tooLarge).toBe(true);
	expect(diff.before).toBeNull();
	expect(diff.after).toBeNull();
});

test("a directory is refused, tracked or not, rather than shown as content", async () => {
	await initRepo(project);
	await mkdir(join(project, "src"));
	await writeFile(join(project, "src", "a.txt"), "one\n");

	// Untracked: the working tree has a directory there.
	await expect(gitDiff(homeDir, SLUG, "src")).rejects.toThrow("not a file");

	// Tracked: HEAD has a tree there, and git show would print its listing.
	await commitAll(project, "first");
	await expect(gitDiff(homeDir, SLUG, "src")).rejects.toThrow("not a file");

	// And when the directory is gone from the working tree but still in HEAD.
	await rm(join(project, "src"), { recursive: true });
	await expect(gitDiff(homeDir, SLUG, "src")).rejects.toThrow("not a file");
});

test("a git timeout is an error, not a missing HEAD side", async () => {
	await initRepo(project);
	await writeFile(join(project, "a.txt"), "one\n");
	await commitAll(project, "first");

	await expect(showFromHead(project, "a.txt", { timeoutMs: 1 })).rejects.toThrow(
		"git timed out",
	);
});

test("an unmerged entry carries the conflict flag", async () => {
	await initRepo(project);
	await writeFile(join(project, "a.txt"), "base\n");
	await commitAll(project, "base");
	await git(["checkout", "-b", "other"], project);
	await writeFile(join(project, "a.txt"), "theirs\n");
	await commitAll(project, "theirs");
	await git(["checkout", "main"], project);
	await writeFile(join(project, "a.txt"), "ours\n");
	await commitAll(project, "ours");
	await expect(git(["merge", "other"], project)).rejects.toThrow();

	const status = await gitStatus(homeDir, SLUG, { hidden: false });
	expect(status.entries.find((entry) => entry.path === "a.txt")?.unmerged).toBe(true);
});

test("the ignored list is capped with the entries and says so", async () => {
	await initRepo(project);
	await writeFile(join(project, ".gitignore"), "*.log\n");
	const noise = join(project, "noise");
	await mkdir(noise);
	for (let i = 0; i < MAX_GIT_ENTRIES + 10; i += 1) {
		await writeFile(join(noise, `f-${i}.log`), "x");
	}

	const status = await gitStatus(homeDir, SLUG, { hidden: true });
	expect(status.entries.length + status.ignored.length).toBe(MAX_GIT_ENTRIES);
	expect(status.truncated).toBe(true);
});

test("a file in a project that is not a repository reads as added", async () => {
	await writeFile(join(project, "loose.txt"), "hello\n");

	const diff = await gitDiff(homeDir, SLUG, "loose.txt");
	expect(diff.status).toBe("A");
	expect(diff.before).toBeNull();
	expect(diff.after).toBe("hello\n");
});

test("a file with no HEAD baseline in a repository with commits is added", async () => {
	await initRepo(project);
	await writeFile(join(project, "a.txt"), "one\n");
	await commitAll(project, "first");
	await writeFile(join(project, "fresh.txt"), "new\n");

	const diff = await gitDiff(homeDir, SLUG, "fresh.txt");
	expect(diff.status).toBe("A");
	expect(diff.before).toBeNull();
	expect(diff.after).toBe("new\n");
});

test("the status route answers over HTTP and honours hidden", async () => {
	await initRepo(project);
	await writeFile(join(project, ".gitignore"), "secret.log\n");
	await writeFile(join(project, "secret.log"), "noise\n");

	const plain = await app.inject({
		method: "GET",
		url: `/projects/${SLUG}/git/status`,
		headers: auth(),
	});
	expect(plain.statusCode).toBe(200);
	expect(plain.json().ignored).toEqual([]);

	const hidden = await app.inject({
		method: "GET",
		url: `/projects/${SLUG}/git/status?hidden=true`,
		headers: auth(),
	});
	expect(hidden.json().ignored).toContain("secret.log");

	const bad = await app.inject({
		method: "GET",
		url: `/projects/${SLUG}/git/status?hidden=maybe`,
		headers: auth(),
	});
	expect(bad.statusCode).toBe(400);
});

test("the status route reports a missing project as not found", async () => {
	const response = await app.inject({
		method: "GET",
		url: "/projects/nope/git/status",
		headers: auth(),
	});
	expect(response.statusCode).toBe(404);
	expect(response.json().error.code).toBe("PROJECT_NOT_FOUND");
});

test("the diff route answers over HTTP and refuses a path leaving the project", async () => {
	await initRepo(project);
	await writeFile(join(project, "a.txt"), "one\n");
	await commitAll(project, "first");
	await writeFile(join(project, "a.txt"), "two\n");

	const ok = await app.inject({
		method: "GET",
		url: `/projects/${SLUG}/git/diff?path=a.txt`,
		headers: auth(),
	});
	expect(ok.statusCode).toBe(200);
	expect(ok.json()).toMatchObject({ status: "M", before: "one\n", after: "two\n" });

	for (const path of ["../../etc/passwd", ""]) {
		const denied = await app.inject({
			method: "GET",
			url: `/projects/${SLUG}/git/diff?path=${encodeURIComponent(path)}`,
			headers: auth(),
		});
		expect(denied.statusCode).toBe(400);
		expect(denied.json().error.code).toBe("PATH_INVALID");
	}
});

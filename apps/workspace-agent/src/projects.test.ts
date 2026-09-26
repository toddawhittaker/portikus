import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	symlink,
	truncate,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MAX_DOWNLOAD_BYTES } from "@portikus/contracts";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { archiveDir, checkDownloadSize, removeStaleTemporaries } from "./projects.js";
import { buildServer } from "./server.js";

const run = promisify(execFile);

const TOKEN = "a".repeat(64);

let app: FastifyInstance;
let homeDir: string;
let projectsRoot: string;

async function available(command: string, args: string[]): Promise<boolean> {
	try {
		await run(command, args);
		return true;
	} catch {
		return false;
	}
}

// skipIf is evaluated at collection time, so probe the tools here.
const haveGit = await available("git", ["--version"]);
const haveZip = (await available("zip", ["-v"])) && (await available("unzip", ["-v"]));

function auth(token = TOKEN) {
	return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-projects-"));
	projectsRoot = join(homeDir, "projects");
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
	await rm(projectsRoot, { recursive: true, force: true });
	await mkdir(projectsRoot, { recursive: true });
});

async function create(payload: Record<string, unknown>) {
	return app.inject({ method: "POST", url: "/projects", headers: auth(), payload });
}

test("listing reports git directories and skips everything else", async () => {
	await mkdir(join(projectsRoot, "alpha", ".git"), { recursive: true });
	await mkdir(join(projectsRoot, "beta"), { recursive: true });
	await mkdir(join(projectsRoot, ".hidden"), { recursive: true });
	await mkdir(join(projectsRoot, "Bad_Name"), { recursive: true });
	await writeFile(join(projectsRoot, "notes.txt"), "hello");

	const response = await app.inject({
		method: "GET",
		url: "/projects",
		headers: auth(),
	});
	expect(response.statusCode).toBe(200);
	const listed = response.json() as {
		projects: { slug: string; isGitRepo: boolean; directoryId?: string }[];
	};
	expect(
		listed.projects.map((p) => ({ slug: p.slug, isGitRepo: p.isGitRepo })),
	).toEqual([
		{ slug: "alpha", isGitRepo: true },
		{ slug: "beta", isGitRepo: false },
	]);
	// Each directory reports its own identity, and no two share one (issue #238).
	const ids = listed.projects.map((p) => p.directoryId);
	expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
	expect(new Set(ids).size).toBe(2);
});

/** Issue #238: a directory renamed with `mv` keeps its reported identity. */
test("a renamed directory keeps the identity it reported before", async () => {
	await mkdir(join(projectsRoot, "alpha", ".git"), { recursive: true });
	const before = await app.inject({ method: "GET", url: "/projects", headers: auth() });
	const was = (before.json() as { projects: { directoryId?: string }[] }).projects[0]
		?.directoryId;

	await rename(join(projectsRoot, "alpha"), join(projectsRoot, "omega"));

	const after = await app.inject({ method: "GET", url: "/projects", headers: auth() });
	const now = after.json() as {
		projects: { slug: string; directoryId?: string }[];
	};
	expect(now.projects[0]?.slug).toBe("omega");
	expect(now.projects[0]?.directoryId).toBe(was);
});

test("one project is fetched and a missing one is a 404", async () => {
	await mkdir(join(projectsRoot, "alpha", ".git"), { recursive: true });
	const found = await app.inject({
		method: "GET",
		url: "/projects/alpha",
		headers: auth(),
	});
	expect(found.json()).toMatchObject({ slug: "alpha", isGitRepo: true });
	expect((found.json() as { directoryId?: string }).directoryId).toBeDefined();

	const missing = await app.inject({
		method: "GET",
		url: "/projects/nope",
		headers: auth(),
	});
	expect(missing.statusCode).toBe(404);
	expect(missing.json().error.code).toBe("PROJECT_NOT_FOUND");
});

test.skipIf(!haveGit)("a new project is created with and without git", async () => {
	const withGit = await create({ slug: "alpha", source: "new", gitInit: true });
	expect(withGit.statusCode).toBe(201);
	expect(withGit.json()).toEqual({ slug: "alpha", isGitRepo: true });

	const without = await create({ slug: "beta", source: "new", gitInit: false });
	expect(without.json()).toEqual({ slug: "beta", isGitRepo: false });
	expect(await readdir(join(projectsRoot, "beta"))).toEqual([]);

	const again = await create({ slug: "alpha", source: "new", gitInit: true });
	expect(again.statusCode).toBe(409);
	expect(again.json().error.code).toBe("PROJECT_EXISTS");
});

test.skipIf(!haveGit)("initializing Git writes a default .gitignore", async () => {
	await create({ slug: "alpha", source: "new", gitInit: true });
	const created = await readFile(join(projectsRoot, "alpha", ".gitignore"), "utf8");
	for (const entry of [".env", "node_modules/", "__pycache__/", "*.sqlite"]) {
		expect(created).toContain(entry);
	}

	// A project made without Git gets nothing written for it.
	await create({ slug: "beta", source: "new", gitInit: false });
	expect(await readdir(join(projectsRoot, "beta"))).toEqual([]);

	// Initialize Git on that same project writes the file.
	await app.inject({
		method: "POST",
		url: "/projects/beta/git-init",
		headers: auth(),
	});
	expect(await readFile(join(projectsRoot, "beta", ".gitignore"), "utf8")).toContain(
		".env",
	);
});

test.skipIf(!haveGit)("an existing .gitignore is left alone", async () => {
	await create({ slug: "alpha", source: "new", gitInit: false });
	await writeFile(join(projectsRoot, "alpha", ".gitignore"), "mine\n");

	await app.inject({
		method: "POST",
		url: "/projects/alpha/git-init",
		headers: auth(),
	});
	expect(await readFile(join(projectsRoot, "alpha", ".gitignore"), "utf8")).toBe(
		"mine\n",
	);
});

test.skipIf(!haveGit)("git-init initializes once and then no-ops", async () => {
	await create({ slug: "alpha", source: "new", gitInit: false });
	const first = await app.inject({
		method: "POST",
		url: "/projects/alpha/git-init",
		headers: auth(),
	});
	expect(first.json()).toEqual({ slug: "alpha", isGitRepo: true });

	const second = await app.inject({
		method: "POST",
		url: "/projects/alpha/git-init",
		headers: auth(),
	});
	expect(second.statusCode).toBe(200);
	expect(second.json()).toEqual({ slug: "alpha", isGitRepo: true });
});

/**
 * A bare repository served over Git's dumb HTTP protocol. The contracts
 * only allow http, https, ssh and scp-like URLs, so a plain path or
 * `file://` cannot be used as a test origin.
 */
async function startOrigin(extraFiles: Record<string, string> = {}): Promise<{
	url: string;
	base: string;
	stop: () => Promise<void>;
}> {
	const work = await mkdtemp(join(tmpdir(), "portikus-origin-"));
	const source = join(work, "source");
	await mkdir(source);
	await writeFile(join(source, "README.md"), "hello\n");
	for (const [name, contents] of Object.entries(extraFiles)) {
		await writeFile(join(source, name), contents);
	}
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
	};
	await run("git", ["init", "-q"], { cwd: source, env });
	await run("git", ["add", "-A"], { cwd: source, env });
	await run("git", ["commit", "-q", "-m", "first"], { cwd: source, env });
	const bare = join(work, "origin.git");
	await run("git", ["clone", "-q", "--bare", source, bare], { env });
	await run("git", ["update-server-info"], { cwd: bare, env });

	const server = createServer((request, response) => {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		const file = join(work, path.replace(/^\/+/, ""));
		// Only ever serves files inside the temporary bare repository.
		if (!file.startsWith(`${bare}/`)) {
			response.writeHead(404).end();
			return;
		}
		createReadStream(file)
			.on("error", () => response.writeHead(404).end())
			.pipe(response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	return {
		url: `http://127.0.0.1:${port}/origin.git`,
		base: `http://127.0.0.1:${port}`,
		stop: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(work, { recursive: true, force: true });
		},
	};
}

test.skipIf(!haveGit)("a clone lands as the project directory", async () => {
	const origin = await startOrigin();
	const response = await create({
		slug: "cloned",
		source: "clone",
		url: origin.url,
		gitInit: true,
	});
	expect(response.statusCode).toBe(201);
	expect(response.json()).toEqual({ slug: "cloned", isGitRepo: true });
	const entries = await readdir(join(projectsRoot, "cloned"));
	expect(entries).toContain("README.md");
	expect(entries).toContain(".git");
	await origin.stop();
});

test.skipIf(!haveGit)("a failed clone leaves nothing behind", async () => {
	const origin = await startOrigin();
	const response = await create({
		slug: "cloned",
		source: "clone",
		url: `${origin.base}/missing.git`,
		gitInit: true,
	});
	expect(response.statusCode).toBe(500);
	expect(response.json().error.code).toBe("GIT_FAILED");
	expect(response.json().error.message).not.toBe("");
	expect(await readdir(projectsRoot)).toEqual([]);
	await origin.stop();
});

test.skipIf(!haveGit)(
	"a template loses its history and gets a fresh repo",
	async () => {
		const origin = await startOrigin();
		const response = await create({
			slug: "fromtemplate",
			source: "template",
			url: origin.url,
			gitInit: true,
		});
		expect(response.statusCode).toBe(201);
		const project = join(projectsRoot, "fromtemplate");
		const { stdout } = await run("git", ["rev-list", "--all", "--count"], {
			cwd: project,
		});
		expect(stdout.trim()).toBe("0");
		expect(await readdir(project)).toContain("README.md");
		await origin.stop();
	},
);

test.skipIf(!haveGit)(
	"a template without a .gitignore gets the default, and one with it keeps it",
	async () => {
		const plain = await startOrigin();
		expect(
			(
				await create({
					slug: "plaintemplate",
					source: "template",
					url: plain.url,
					gitInit: true,
				})
			).statusCode,
		).toBe(201);
		expect(
			await readFile(join(projectsRoot, "plaintemplate", ".gitignore"), "utf8"),
		).toContain("node_modules/");
		await plain.stop();

		const opinionated = await startOrigin({ ".gitignore": "theirs\n" });
		expect(
			(
				await create({
					slug: "opinionated",
					source: "template",
					url: opinionated.url,
					gitInit: true,
				})
			).statusCode,
		).toBe(201);
		expect(
			await readFile(join(projectsRoot, "opinionated", ".gitignore"), "utf8"),
		).toBe("theirs\n");
		await opinionated.stop();
	},
);

test("a clone URL the contracts refuse is a 400", async () => {
	const response = await create({
		slug: "cloned",
		source: "clone",
		url: "ext::sh -c whoami",
		gitInit: true,
	});
	expect(response.statusCode).toBe(400);
});

test("rename moves the directory and refuses an existing target", async () => {
	await mkdir(join(projectsRoot, "alpha", ".git"), { recursive: true });
	await mkdir(join(projectsRoot, "beta"), { recursive: true });

	const renamed = await app.inject({
		method: "POST",
		url: "/projects/alpha/rename",
		headers: auth(),
		payload: { to: "gamma" },
	});
	expect(renamed.json()).toEqual({ slug: "gamma", isGitRepo: true });
	expect((await readdir(projectsRoot)).sort()).toEqual(["beta", "gamma"]);

	const clash = await app.inject({
		method: "POST",
		url: "/projects/gamma/rename",
		headers: auth(),
		payload: { to: "beta" },
	});
	expect(clash.statusCode).toBe(409);

	const missing = await app.inject({
		method: "POST",
		url: "/projects/nope/rename",
		headers: auth(),
		payload: { to: "delta" },
	});
	expect(missing.statusCode).toBe(404);
});

test("delete removes the directory and 404s when it is not there", async () => {
	await mkdir(join(projectsRoot, "alpha", "inner"), { recursive: true });
	await writeFile(join(projectsRoot, "alpha", "inner", "file.txt"), "content\n");
	await mkdir(join(projectsRoot, "beta"), { recursive: true });

	const deleted = await app.inject({
		method: "DELETE",
		url: "/projects/alpha",
		headers: auth(),
	});
	expect(deleted.statusCode).toBe(204);
	expect(await readdir(projectsRoot)).toEqual(["beta"]);

	const missing = await app.inject({
		method: "DELETE",
		url: "/projects/alpha",
		headers: auth(),
	});
	expect(missing.statusCode).toBe(404);
	expect(missing.json().error.code).toBe("PROJECT_NOT_FOUND");
});

test("delete refuses a slug that is not a valid slug", async () => {
	const response = await app.inject({
		method: "DELETE",
		url: "/projects/..%2Fx",
		headers: auth(),
	});
	expect(response.statusCode).toBe(400);
	expect(response.json().error.code).toBe("INVALID_SLUG");
});

test("deleting a symlinked project removes the link, not its target", async () => {
	const outside = await mkdtemp(join(tmpdir(), "portikus-outside-"));
	await writeFile(join(outside, "keep.txt"), "keep\n");
	await symlink(outside, join(projectsRoot, "escape"));
	await mkdir(join(projectsRoot, "alpha"), { recursive: true });
	await symlink(join(projectsRoot, "alpha"), join(projectsRoot, "shortcut"));

	for (const slug of ["escape", "shortcut"]) {
		const response = await app.inject({
			method: "DELETE",
			url: `/projects/${slug}`,
			headers: auth(),
		});
		expect(response.statusCode).toBe(204);
	}

	// Only the links went; both targets are untouched.
	expect((await readdir(projectsRoot)).sort()).toEqual(["alpha"]);
	expect((await readdir(outside)).sort()).toEqual(["keep.txt"]);

	await rm(outside, { recursive: true, force: true });
});

test("duplicate copies symlinks without following them", async () => {
	const alpha = join(projectsRoot, "alpha");
	await mkdir(alpha, { recursive: true });
	await writeFile(join(alpha, "file.txt"), "content\n");
	await symlink("file.txt", join(alpha, "inside.link"));
	await symlink("/etc/passwd", join(alpha, "outside.link"));

	const copied = await app.inject({
		method: "POST",
		url: "/projects/alpha/duplicate",
		headers: auth(),
		payload: { to: "beta" },
	});
	expect(copied.json()).toEqual({ slug: "beta", isGitRepo: false });

	const beta = join(projectsRoot, "beta");
	expect(await readlink(join(beta, "inside.link"))).toBe("file.txt");
	// Still a symlink, so the copy never read the file it points at.
	expect(await readlink(join(beta, "outside.link"))).toBe("/etc/passwd");

	const clash = await app.inject({
		method: "POST",
		url: "/projects/alpha/duplicate",
		headers: auth(),
		payload: { to: "beta" },
	});
	expect(clash.statusCode).toBe(409);
});

test.skipIf(!haveZip)("archive streams a zip that unzip accepts", async () => {
	const alpha = join(projectsRoot, "alpha");
	await mkdir(alpha, { recursive: true });
	await writeFile(join(alpha, "file.txt"), "content\n");

	const response = await app.inject({
		method: "GET",
		url: "/projects/alpha/archive",
		headers: auth(),
	});
	expect(response.statusCode).toBe(200);
	expect(response.headers["content-type"]).toContain("application/zip");

	const archive = join(homeDir, "alpha.zip");
	await writeFile(archive, response.rawPayload);
	const { stdout } = await run("unzip", ["-l", archive]);
	expect(stdout).toContain("alpha/file.txt");
	await run("unzip", ["-t", archive]);
	await rm(archive, { force: true });
});

test.skipIf(!haveZip)("a finished archive leaves no temporary zip behind", async () => {
	const tempBase = await mkdtemp(join(tmpdir(), "portikus-archive-base-"));
	const alpha = join(projectsRoot, "alpha");
	await mkdir(alpha, { recursive: true });
	await writeFile(join(alpha, "file.txt"), "content\n");
	try {
		const stream = await archiveDir(alpha, new AbortController().signal, tempBase);
		for await (const _chunk of stream) {
			// Drain it, as a download would.
		}
		// The removal runs on close without being awaited, so poll for it.
		await expect.poll(() => readdir(tempBase)).toEqual([]);
	} finally {
		await rm(tempBase, { recursive: true, force: true });
	}
});

test("an aborted archive kills zip and leaves no temporary zip behind", async () => {
	const tempBase = await mkdtemp(join(tmpdir(), "portikus-archive-base-"));
	const fakeBin = await mkdtemp(join(tmpdir(), "portikus-fakebin-"));
	// A zip that takes far longer than any test, and records its process id.
	const pidFile = join(fakeBin, "pid");
	await writeFile(
		join(fakeBin, "zip"),
		`#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 60\n`,
		{
			mode: 0o755,
		},
	);
	const alpha = join(projectsRoot, "alpha");
	await mkdir(alpha, { recursive: true });
	const realPath = process.env.PATH;
	process.env.PATH = `${fakeBin}:${realPath}`;
	try {
		const controller = new AbortController();
		const pending = archiveDir(alpha, controller.signal, tempBase).catch((e) => e);
		await expect.poll(() => readFile(pidFile, "utf8").catch(() => "")).not.toBe("");
		expect(await readdir(tempBase)).toHaveLength(1);
		controller.abort();
		expect(await pending).toBeInstanceOf(Error);
		expect(await readdir(tempBase)).toEqual([]);
		const pid = Number((await readFile(pidFile, "utf8")).trim());
		await expect
			.poll(() => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			})
			.toBe(false);
	} finally {
		process.env.PATH = realPath;
		await rm(fakeBin, { recursive: true, force: true });
		await rm(tempBase, { recursive: true, force: true });
	}
});

test("archiving a project that does not exist is a 404", async () => {
	const response = await app.inject({
		method: "GET",
		url: "/projects/nope/archive",
		headers: auth(),
	});
	expect(response.statusCode).toBe(404);
});

test("traversal and symlinked slugs are refused", async () => {
	const outside = await mkdtemp(join(tmpdir(), "portikus-outside-"));
	await symlink(outside, join(projectsRoot, "escape"));

	const traversal = await app.inject({
		method: "GET",
		url: "/projects/..%2Fx",
		headers: auth(),
	});
	expect(traversal.statusCode).toBe(400);
	expect(traversal.json().error.code).toBe("INVALID_SLUG");

	for (const url of ["/projects/escape", "/projects/escape/archive"]) {
		const response = await app.inject({ method: "GET", url, headers: auth() });
		expect(response.statusCode).toBe(400);
		expect(response.json().error.code).toBe("INVALID_SLUG");
	}

	const renamed = await app.inject({
		method: "POST",
		url: "/projects/escape/rename",
		headers: auth(),
		payload: { to: "safe" },
	});
	expect(renamed.statusCode).toBe(400);

	const created = await create({ slug: "escape", source: "new", gitInit: false });
	expect(created.statusCode).toBe(400);

	await rm(outside, { recursive: true, force: true });
});

test("a slug that is a symlink to a sibling project is refused", async () => {
	await mkdir(join(projectsRoot, "alpha", ".git"), { recursive: true });
	await symlink(join(projectsRoot, "alpha"), join(projectsRoot, "shortcut"));

	for (const url of [
		"/projects/shortcut",
		"/projects/shortcut/archive",
		"/projects/shortcut/git-init",
	]) {
		const response = await app.inject({
			method: url.endsWith("git-init") ? "POST" : "GET",
			url,
			headers: auth(),
		});
		expect(response.statusCode).toBe(400);
		expect(response.json().error.code).toBe("INVALID_SLUG");
	}
});

test("stale half-finished clone directories are removed at startup", async () => {
	await mkdir(join(projectsRoot, ".tmp-abc123", "inner"), { recursive: true });
	await mkdir(join(projectsRoot, ".tmp-def456"), { recursive: true });
	await mkdir(join(projectsRoot, "alpha"), { recursive: true });

	const removed = await removeStaleTemporaries(homeDir);
	expect(removed.sort()).toEqual([".tmp-abc123", ".tmp-def456"]);
	expect((await readdir(projectsRoot)).sort()).toEqual(["alpha"]);
});

test("the agent survives an image with no zip installed", async () => {
	const emptyBin = await mkdtemp(join(tmpdir(), "portikus-nobin-"));
	await mkdir(join(projectsRoot, "alpha"), { recursive: true });
	const realPath = process.env.PATH;
	process.env.PATH = emptyBin;
	try {
		const response = await app.inject({
			method: "GET",
			url: "/projects/alpha/archive",
			headers: auth(),
		});
		expect(response.statusCode).toBe(500);
		expect(response.json().error.code).toBe("INTERNAL");
	} finally {
		process.env.PATH = realPath;
		await rm(emptyBin, { recursive: true, force: true });
	}

	// The agent is still answering.
	const health = await app.inject({ method: "GET", url: "/health", headers: auth() });
	expect(health.statusCode).toBe(200);
});

test("a duplicate that fails part way leaves no half-copied project", async () => {
	const fakeBin = await mkdtemp(join(tmpdir(), "portikus-fakebin-"));
	// A cp that makes the target, writes into it, and then gives up.
	await writeFile(
		join(fakeBin, "cp"),
		'#!/bin/sh\nfor target in "$@"; do :; done\nmkdir -p "$target"\necho partial > "$target/partial.txt"\nexit 1\n',
		{ mode: 0o755 },
	);
	await mkdir(join(projectsRoot, "alpha"), { recursive: true });
	await writeFile(join(projectsRoot, "alpha", "file.txt"), "content\n");

	const realPath = process.env.PATH;
	process.env.PATH = `${fakeBin}:${realPath}`;
	try {
		const response = await app.inject({
			method: "POST",
			url: "/projects/alpha/duplicate",
			headers: auth(),
			payload: { to: "beta" },
		});
		expect(response.statusCode).toBe(500);
		expect(response.json().error.code).toBe("GIT_FAILED");
	} finally {
		process.env.PATH = realPath;
		await rm(fakeBin, { recursive: true, force: true });
	}

	expect(await readdir(projectsRoot)).not.toContain("beta");
});

test("every project route needs the bearer token", async () => {
	const requests: InjectOptions[] = [
		{ method: "GET", url: "/projects" },
		{ method: "GET", url: "/projects/alpha" },
		{
			method: "POST",
			url: "/projects",
			payload: { slug: "a", source: "new", gitInit: true },
		},
		{ method: "POST", url: "/projects/alpha/rename", payload: { to: "beta" } },
		{ method: "POST", url: "/projects/alpha/duplicate", payload: { to: "beta" } },
		{ method: "POST", url: "/projects/alpha/git-init" },
		{ method: "GET", url: "/projects/alpha/archive" },
	];
	for (const request of requests) {
		const response = await app.inject({ ...request, headers: auth("b".repeat(64)) });
		expect(response.statusCode).toBe(401);
		expect(response.json().error.code).toBe("UNAUTHORIZED");
	}
});

/** A sparse file: the apparent size, without using the disk. */
async function sparse(path: string, size: number) {
	await writeFile(path, "");
	await truncate(path, size);
}

test("a folder past the download cap is refused before zip runs (#399)", async () => {
	const tempBase = await mkdtemp(join(tmpdir(), "portikus-archive-base-"));
	const alpha = join(projectsRoot, "alpha");
	await mkdir(join(alpha, "src"), { recursive: true });
	await sparse(join(alpha, "a.bin"), MAX_DOWNLOAD_BYTES / 2);
	await sparse(join(alpha, "src", "b.bin"), MAX_DOWNLOAD_BYTES / 2 + 1);
	try {
		await expect(
			archiveDir(alpha, new AbortController().signal, tempBase),
		).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
		expect(await readdir(tempBase)).toEqual([]);
	} finally {
		await rm(tempBase, { recursive: true, force: true });
	}
});

test("a symlink to a file past the download cap is refused (#399)", async () => {
	const alpha = join(projectsRoot, "alpha");
	await mkdir(alpha, { recursive: true });
	await sparse(join(alpha, "big.bin"), MAX_DOWNLOAD_BYTES + 1);
	await symlink("big.bin", join(alpha, "link.bin"));
	await expect(checkDownloadSize(join(alpha, "link.bin"))).rejects.toMatchObject({
		code: "FILE_TOO_LARGE",
	});
});

test("the project archive route refuses a project past the cap with FILE_TOO_LARGE", async () => {
	await mkdir(join(projectsRoot, "alpha"), { recursive: true });
	await sparse(join(projectsRoot, "alpha", "big.bin"), MAX_DOWNLOAD_BYTES + 1);
	const response = await app.inject({
		method: "GET",
		url: "/projects/alpha/archive",
		headers: auth(),
	});
	expect(response.statusCode).toBe(413);
	expect(response.json().error.code).toBe("FILE_TOO_LARGE");
});

test("the size check does not follow a symlink out of the folder", async () => {
	const outside = await mkdtemp(join(tmpdir(), "portikus-outside-"));
	await sparse(join(outside, "big.bin"), MAX_DOWNLOAD_BYTES + 1);
	await mkdir(join(projectsRoot, "alpha"), { recursive: true });
	await symlink(outside, join(projectsRoot, "alpha", "link"));
	await symlink(join(outside, "big.bin"), join(projectsRoot, "alpha", "file-link"));
	try {
		const response = await app.inject({
			method: "GET",
			url: "/projects/alpha/archive?check=1",
			headers: auth(),
		});
		expect(response.statusCode).toBe(204);
	} finally {
		await rm(outside, { recursive: true, force: true });
	}
});

test("a size check answers for a file, a folder, or the project without zipping", async () => {
	await mkdir(join(projectsRoot, "alpha", "small"), { recursive: true });
	await writeFile(join(projectsRoot, "alpha", "small", "a.txt"), "a\n");
	await sparse(join(projectsRoot, "alpha", "big.bin"), MAX_DOWNLOAD_BYTES + 1);
	const check = (query: string) =>
		app.inject({
			method: "GET",
			url: `/projects/alpha/archive?check=1${query}`,
			headers: auth(),
		});
	expect((await check("&path=small")).statusCode).toBe(204);
	expect((await check("&path=small%2Fa.txt")).statusCode).toBe(204);
	const file = await check("&path=big.bin");
	expect(file.statusCode).toBe(413);
	expect(file.json().error.code).toBe("FILE_TOO_LARGE");
	expect((await check("")).statusCode).toBe(413);
});

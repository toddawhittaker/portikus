import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ChecksFile } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
	excludePortikusFiles,
	PORTIKUS_README,
	writePortikusReadme,
} from "./project-files.js";
import { buildServer } from "./server.js";

const run = promisify(execFile);
const TOKEN = "b".repeat(64);
const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.invalid",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.invalid",
};

let haveGit = true;
try {
	await run("git", ["--version"]);
} catch {
	haveGit = false;
}

let app: FastifyInstance;
let homeDir: string;
let projectsRoot: string;

beforeAll(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-project-files-"));
	projectsRoot = join(homeDir, "projects");
	const tokenPath = join(homeDir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	app = buildServer({ tmuxSocketName: "portikus-test-pf", tokenPath, homeDir });
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

function post(url: string, payload?: Record<string, unknown>) {
	return app.inject({
		method: "POST",
		url,
		headers: { authorization: `Bearer ${TOKEN}` },
		...(payload === undefined ? {} : { payload }),
	});
}

async function head(dir: string): Promise<string> {
	return (await run("git", ["symbolic-ref", "HEAD"], { cwd: dir })).stdout.trim();
}

/** Which of `paths` Git ignores in `dir`. */
async function ignored(dir: string, paths: string[]): Promise<string[]> {
	try {
		const { stdout } = await run("git", ["check-ignore", "--", ...paths], { cwd: dir });
		return stdout.split("\n").filter((line) => line !== "");
	} catch (error) {
		// Exit code 1 means none of them is ignored.
		if ((error as { code?: number }).code === 1) return [];
		throw error;
	}
}

const PORTIKUS_PATHS = [
	".portikus/pastes/one.png",
	".portikus/checks.json",
	".portikus/README.md",
];

/** A repository served over Git's dumb HTTP protocol, as in projects.test.ts. */
async function startOrigin(files: Record<string, string>) {
	const work = await mkdtemp(join(tmpdir(), "portikus-pf-origin-"));
	const source = join(work, "source");
	await mkdir(source);
	for (const [name, contents] of Object.entries(files)) {
		await writeFile(join(source, name), contents);
	}
	await run("git", ["init", "-q"], { cwd: source, env: GIT_ENV });
	await run("git", ["add", "-A"], { cwd: source, env: GIT_ENV });
	await run("git", ["commit", "-q", "-m", "first"], { cwd: source, env: GIT_ENV });
	const bare = join(work, "origin.git");
	await run("git", ["clone", "-q", "--bare", source, bare], { env: GIT_ENV });
	await run("git", ["update-server-info"], { cwd: bare, env: GIT_ENV });
	const server = createServer((request, response) => {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		const file = join(work, path.replace(/^\/+/, ""));
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
		stop: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(work, { recursive: true, force: true });
		},
	};
}

test("the README's checks example is a valid checks.json", () => {
	const example = /```json\n([\s\S]*?)```/.exec(PORTIKUS_README)?.[1];
	expect(example).toBeDefined();
	expect(ChecksFile.safeParse(JSON.parse(example as string)).success).toBe(true);
});

test.skipIf(!haveGit)(
	"a new project starts on main, ignores .portikus working files, and gets the README",
	async () => {
		const response = await post("/projects", {
			slug: "fresh",
			source: "new",
			gitInit: true,
		});
		expect(response.statusCode).toBe(201);
		const dir = join(projectsRoot, "fresh");
		expect(await head(dir)).toBe("refs/heads/main");
		expect(await ignored(dir, PORTIKUS_PATHS)).toEqual([".portikus/pastes/one.png"]);
		expect(await readFile(join(dir, ".portikus", "README.md"), "utf8")).toBe(
			PORTIKUS_README,
		);
		// Nothing is committed on the student's behalf (SPEC.md §12.5).
		await expect(run("git", ["rev-parse", "HEAD"], { cwd: dir })).rejects.toThrow();
	},
);

test("a new project without Git still gets the README", async () => {
	const response = await post("/projects", {
		slug: "plain",
		source: "new",
		gitInit: false,
	});
	expect(response.statusCode).toBe(201);
	expect(
		await readFile(join(projectsRoot, "plain", ".portikus", "README.md"), "utf8"),
	).toBe(PORTIKUS_README);
});

test.skipIf(!haveGit)("Initialize Git starts the repository on main", async () => {
	await mkdir(join(projectsRoot, "later"));
	expect((await post("/projects/later/git-init")).statusCode).toBe(200);
	expect(await head(join(projectsRoot, "later"))).toBe("refs/heads/main");
});

test.skipIf(!haveGit)(
	"Initialize Git with an existing .gitignore puts the lines in .git/info/exclude",
	async () => {
		const dir = join(projectsRoot, "own");
		await mkdir(dir);
		await writeFile(join(dir, ".gitignore"), "mine\n");
		expect((await post("/projects/own/git-init")).statusCode).toBe(200);
		expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("mine\n");
		expect(await ignored(dir, PORTIKUS_PATHS)).toEqual([".portikus/pastes/one.png"]);
	},
);

test.skipIf(!haveGit)(
	"a template starts on main, keeps its .gitignore, and gets the README",
	async () => {
		const origin = await startOrigin({ ".gitignore": "theirs\n", "a.txt": "a\n" });
		const response = await post("/projects", {
			slug: "tpl",
			source: "template",
			url: origin.url,
			gitInit: true,
		});
		expect(response.statusCode).toBe(201);
		const dir = join(projectsRoot, "tpl");
		expect(await head(dir)).toBe("refs/heads/main");
		expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("theirs\n");
		expect(await ignored(dir, PORTIKUS_PATHS)).toEqual([".portikus/pastes/one.png"]);
		expect(await readFile(join(dir, ".portikus", "README.md"), "utf8")).toBe(
			PORTIKUS_README,
		);
		await origin.stop();
	},
);

test.skipIf(!haveGit)(
	"a clone changes no tracked file, ignores .portikus working files, and names itself",
	async () => {
		const origin = await startOrigin({
			"README.md": "Intro\n\n# **IPEDS** [Oracle](https://example.com)\n",
			".gitignore": "theirs\n",
		});
		const response = await post("/projects", {
			slug: "ipeds-oracle",
			source: "clone",
			url: origin.url,
			gitInit: true,
		});
		expect(response.statusCode).toBe(201);
		expect(response.json().suggestedName).toBe("IPEDS Oracle");
		const dir = join(projectsRoot, "ipeds-oracle");
		const { stdout } = await run("git", ["status", "--porcelain"], { cwd: dir });
		expect(stdout).toBe("");
		expect(await ignored(dir, PORTIKUS_PATHS)).toEqual([".portikus/pastes/one.png"]);
		await origin.stop();
	},
);

test.skipIf(!haveGit)(
	"a clone without a README heading falls back to package.json",
	async () => {
		const origin = await startOrigin({
			"README.md": "no heading here\n",
			"package.json": JSON.stringify({ name: "@scope/todo-api" }),
		});
		const response = await post("/projects", {
			slug: "todo",
			source: "clone",
			url: origin.url,
			gitInit: true,
		});
		expect(response.json().suggestedName).toBe("Todo Api");
		await origin.stop();
	},
);

test("the exclude lines are added once", async () => {
	const dir = await mkdtemp(join(tmpdir(), "portikus-exclude-"));
	await mkdir(join(dir, ".git", "info"), { recursive: true });
	await writeFile(join(dir, ".git", "info", "exclude"), "# git's own\n*.tmp");
	await excludePortikusFiles(dir);
	await excludePortikusFiles(dir);
	expect(await readFile(join(dir, ".git", "info", "exclude"), "utf8")).toBe(
		"# git's own\n*.tmp\n.portikus/*\n!.portikus/checks.json\n!.portikus/README.md\n",
	);
	await rm(dir, { recursive: true, force: true });
});

test("an existing README is never overwritten, and a symlinked .portikus is not followed", async () => {
	const dir = await mkdtemp(join(tmpdir(), "portikus-readme-"));
	await mkdir(join(dir, "a", ".portikus"), { recursive: true });
	await writeFile(join(dir, "a", ".portikus", "README.md"), "mine\n");
	await writePortikusReadme(join(dir, "a"));
	expect(await readFile(join(dir, "a", ".portikus", "README.md"), "utf8")).toBe(
		"mine\n",
	);

	await mkdir(join(dir, "outside"));
	await mkdir(join(dir, "b"));
	await symlink(join(dir, "outside"), join(dir, "b", ".portikus"));
	await writePortikusReadme(join(dir, "b"));
	await expect(readFile(join(dir, "outside", "README.md"), "utf8")).rejects.toThrow();
	await rm(dir, { recursive: true, force: true });
});

test("an unexpected project route error is INTERNAL, not TMUX_FAILED", async () => {
	// ~/projects as a file makes listing fail in a way no route expects.
	await rm(projectsRoot, { recursive: true, force: true });
	await writeFile(projectsRoot, "not a directory");
	const response = await app.inject({
		method: "GET",
		url: "/projects",
		headers: { authorization: `Bearer ${TOKEN}` },
	});
	expect(response.statusCode).toBe(500);
	expect(response.json().error.code).toBe("INTERNAL");
	await rm(projectsRoot, { force: true });
});

function put(slug: string, path: string, body: string) {
	return app.inject({
		method: "PUT",
		url: `/projects/${slug}/file?path=${encodeURIComponent(path)}`,
		headers: {
			authorization: `Bearer ${TOKEN}`,
			"if-none-match": "*",
			"content-type": "text/plain",
		},
		payload: body,
	});
}

/** A project made before #868: a repository with its own .gitignore and no exclude lines. */
async function olderRepo(slug: string): Promise<string> {
	const dir = join(projectsRoot, slug);
	await mkdir(dir, { recursive: true });
	await run("git", ["init", "-q"], { cwd: dir, env: GIT_ENV });
	await writeFile(join(dir, ".gitignore"), "node_modules/\n");
	await rm(join(dir, ".git", "info", "exclude"), { force: true });
	return dir;
}

test.skipIf(!haveGit)(
	"an older repository gets the exclude lines on its first write under .portikus",
	async () => {
		const dir = await olderRepo("older");
		for (const path of [".portikus", ".portikus/pastes"]) {
			expect((await post("/projects/older/mkdir", { path })).statusCode).toBe(201);
		}
		expect((await put("older", ".portikus/pastes/one.png", "png")).statusCode).toBe(
			200,
		);
		expect((await put("older", ".portikus/checks.json", "{}")).statusCode).toBe(200);

		const { stdout } = await run(
			"git",
			["status", "--porcelain", "--untracked-files=all"],
			{
				cwd: dir,
			},
		);
		expect(stdout).toContain(".portikus/checks.json");
		expect(stdout).not.toContain("pastes");
		expect(await ignored(dir, PORTIKUS_PATHS)).toEqual([".portikus/pastes/one.png"]);
		expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n");

		const exclude = await readFile(join(dir, ".git", "info", "exclude"), "utf8");
		expect(exclude.split("\n").filter((line) => line === ".portikus/*")).toHaveLength(
			1,
		);
		// No README on these writes; that is for new projects only (#857).
		await expect(readFile(join(dir, ".portikus", "README.md"))).rejects.toThrow();
	},
);

test.skipIf(!haveGit)(
	"a write outside .portikus leaves the exclude file alone",
	async () => {
		const dir = await olderRepo("plainwrite");
		expect((await put("plainwrite", "notes.txt", "hi")).statusCode).toBe(200);
		await expect(readFile(join(dir, ".git", "info", "exclude"))).rejects.toThrow();
	},
);

test("a project that is not a Git repository is left alone", async () => {
	const dir = join(projectsRoot, "nogit");
	await mkdir(join(dir, ".portikus"), { recursive: true });
	expect((await put("nogit", ".portikus/checks.json", "{}")).statusCode).toBe(200);
	await expect(readFile(join(dir, ".git"))).rejects.toThrow();
});

test.skipIf(!haveGit)("a failed exclude update does not fail the write", async () => {
	const dir = await olderRepo("broken");
	await rm(join(dir, ".git", "info"), { recursive: true, force: true });
	await writeFile(join(dir, ".git", "info"), "not a directory");
	await mkdir(join(dir, ".portikus"));
	expect((await put("broken", ".portikus/checks.json", "{}")).statusCode).toBe(200);
});

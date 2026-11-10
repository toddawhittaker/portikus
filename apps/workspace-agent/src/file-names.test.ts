import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { MAX_FILE_NAME_MATCHES } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { AgentFailure } from "./errors.js";
import { MAX_RUNNING_FILE_NAME_SEARCHES, searchFileNames } from "./file-names.js";
import { buildServer } from "./server.js";

const run = promisify(execFile);

const TOKEN = "a".repeat(64);

let homeDir: string;
let projectDir: string;
let app: FastifyInstance;

// skipIf is evaluated at collection time, so probe ripgrep here.
const haveRg = await (async () => {
	try {
		await run("rg", ["--version"]);
		return true;
	} catch {
		return false;
	}
})();

async function put(relPath: string, text = "x"): Promise<void> {
	const full = join(projectDir, relPath);
	await mkdir(dirname(full), { recursive: true });
	await writeFile(full, text);
}

beforeAll(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-file-names-"));
	projectDir = join(homeDir, "projects", "demo");
	await mkdir(projectDir, { recursive: true });
	const tokenPath = join(homeDir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });

	// A secret beside the project, and links that point at it.
	await mkdir(join(homeDir, "outside"), { recursive: true });
	await writeFile(join(homeDir, "outside", "secret-notes.txt"), "secret");
	await writeFile(join(homeDir, "secret-at-home.txt"), "secret");
	await symlink(join(homeDir, "outside"), join(projectDir, "linked-outside"));
	await symlink(
		join(homeDir, "outside", "secret-notes.txt"),
		join(projectDir, "linked-secret.txt"),
	);

	await put("README.md");
	await put("src/Composer.tsx");
	await put("src/composer.css");
	await put("src/deep/notcomposer.ts");
	await put("src/app.ts");
	await put("docs/composing-guide.md");
	await put("node_modules/lib/index.js");
	await put("build/out.js");
	await put(".gitignore", "node_modules/\nbuild/\n*.log\n");
	await put("debug.log");
	await put(".env", "TOKEN=1");
	await put(".portikus/pastes/p.png");
	await put(".git/config");
	await put("with space/ünï.txt");

	app = buildServer({ tmuxSocketName: "portikus-test", tokenPath, homeDir });
	await app.ready();
});

afterAll(async () => {
	await app.close();
	await rm(homeDir, { recursive: true, force: true });
});

const find = (query: string, limit = 20, options = {}) =>
	searchFileNames(homeDir, "demo", query, limit, options);

test.skipIf(!haveRg)("a name fragment matches without regard to case", async () => {
	const result = await find("COMPOSER");
	expect(result.paths).toContain("src/Composer.tsx");
	expect(result.paths).toContain("src/composer.css");
	expect(result.truncated).toBe(false);
});

test.skipIf(!haveRg)(
	"the exact name comes first, then a prefix, a substring, a path match, then a gap match",
	async () => {
		const result = await find("composer.tsx");
		expect(result.paths[0]).toBe("src/Composer.tsx");

		const ranked = await find("composer");
		expect(ranked.paths).toEqual([
			// Prefix of the file name; equal length, so in code-unit order.
			"src/Composer.tsx",
			"src/composer.css",
			// Inside the file name.
			"src/deep/notcomposer.ts",
		]);

		const folder = await find("deep");
		expect(folder.paths).toEqual(["src/deep/notcomposer.ts"]);

		const gaps = await find("cmpsr");
		expect(gaps.paths).toContain("src/Composer.tsx");
		expect(gaps.paths).not.toContain("README.md");
	},
);

test.skipIf(!haveRg)("an exact name outranks a longer prefix match", async () => {
	await put("a/app.tsx");
	const result = await find("app.ts");
	expect(result.paths[0]).toBe("src/app.ts");
});

test.skipIf(!haveRg)("paths are relative and non-ASCII names survive", async () => {
	const result = await find("ünï");
	expect(result.paths).toEqual(["with space/ünï.txt"]);
});

test.skipIf(!haveRg)(
	".gitignore is respected, with or without a git repo",
	async () => {
		const all = (await find("", MAX_FILE_NAME_MATCHES)).paths;
		expect(all).toContain("README.md");
		expect(all.some((path) => path.startsWith("node_modules/"))).toBe(false);
		expect(all.some((path) => path.startsWith("build/"))).toBe(false);
		expect(all).not.toContain("debug.log");
	},
);

test.skipIf(!haveRg)(
	"hidden files and folders are left out, as the file tree leaves them out",
	async () => {
		const all = (await find("", MAX_FILE_NAME_MATCHES)).paths;
		for (const path of all) {
			expect(path.split("/").some((part) => part.startsWith("."))).toBe(false);
		}
		expect((await find("env")).paths).toEqual([]);
		expect((await find("config")).paths).toEqual([]);
		expect((await find("pastes")).paths).toEqual([]);
	},
);

test.skipIf(!haveRg)("symlinks are neither followed nor listed", async () => {
	expect((await find("secret")).paths).toEqual([]);
	expect((await find("linked")).paths).toEqual([]);
});

test.skipIf(!haveRg)(
	"a query is never a path: .., absolute and slashed queries reach nothing outside",
	async () => {
		for (const query of [
			"../secret-at-home.txt",
			"../../",
			"/etc/passwd",
			`${homeDir}/secret-at-home.txt`,
			"..",
			"linked-outside/secret-notes.txt",
			"%2e%2e/",
		]) {
			const result = await find(query);
			expect(result.paths).toEqual([]);
		}
	},
);

test.skipIf(!haveRg)(
	"every returned path is one the file routes would accept",
	async () => {
		const { ProjectPath } = await import("@portikus/contracts");
		const result = await find("", MAX_FILE_NAME_MATCHES);
		expect(result.paths.length).toBeGreaterThan(0);
		for (const path of result.paths) {
			expect(ProjectPath.safeParse(path).success).toBe(true);
		}
	},
);

test.skipIf(!haveRg)("an empty query lists shallow files first", async () => {
	const result = await find("", MAX_FILE_NAME_MATCHES);
	const depths = result.paths.map((path) => path.split("/").length);
	expect(depths).toEqual([...depths].sort((a, b) => a - b));
	expect(result.paths[0]).toBe("README.md");
});

test.skipIf(!haveRg)("the limit cuts the answer and says so", async () => {
	const cut = await find("", 3);
	expect(cut.paths).toHaveLength(3);
	expect(cut.truncated).toBe(true);

	const exact = await find("README", 1);
	expect(exact.paths).toEqual(["README.md"]);
	expect(exact.truncated).toBe(false);
});

test.skipIf(!haveRg)("a cap on files scanned stops the scan and says so", async () => {
	const result = await find("", MAX_FILE_NAME_MATCHES, { maxScanned: 2 });
	expect(result.truncated).toBe(true);
	expect(result.paths.length).toBeLessThanOrEqual(2);
});

test.skipIf(!haveRg)(
	"a search that runs out of time answers with what it has",
	async () => {
		const result = await find("", 20, {
			timeoutMs: 100,
			// A stopped ripgrep never answers, so only the time limit can end this.
			onChild: (child: { kill: (signal: string) => void }) => child.kill("SIGSTOP"),
		});
		expect(result).toEqual({ paths: [], truncated: true });
	},
);

test.skipIf(!haveRg)("a search whose caller goes away stops", async () => {
	const controller = new AbortController();
	const pending = find("", 20, {
		timeoutMs: 10_000,
		signal: controller.signal,
		onChild: (child: { kill: (signal: string) => void }) => {
			child.kill("SIGSTOP");
			setTimeout(() => controller.abort(), 20);
		},
	});
	await expect(pending).resolves.toEqual({ paths: [], truncated: false });
});

test.skipIf(!haveRg)("only a few searches run at once", async () => {
	const controller = new AbortController();
	const stop = (child: { kill: (signal: string) => void }) => child.kill("SIGSTOP");
	const running = Array.from({ length: MAX_RUNNING_FILE_NAME_SEARCHES }, () =>
		find("", 20, { timeoutMs: 10_000, signal: controller.signal, onChild: stop }),
	);
	// Let every one of them reach its spawn.
	await new Promise((resolve) => setTimeout(resolve, 200));
	await expect(find("README")).rejects.toMatchObject({ code: "BUSY" });
	controller.abort();
	await Promise.all(running);
	// The slots come back.
	expect((await find("README")).paths).toEqual(["README.md"]);
});

test.skipIf(!haveRg)("an unknown project is not found", async () => {
	await expect(searchFileNames(homeDir, "missing", "x", 20, {})).rejects.toBeInstanceOf(
		AgentFailure,
	);
	await expect(searchFileNames(homeDir, "missing", "x", 20, {})).rejects.toMatchObject({
		code: "PROJECT_NOT_FOUND",
	});
});

// The route (SPEC.md §11.5): the agent's token guards it like every other.
const post = (slug: string, body: unknown, token: string | null = TOKEN) =>
	app.inject({
		method: "POST",
		url: `/projects/${slug}/file-search`,
		headers: token ? { authorization: `Bearer ${token}` } : {},
		payload: body as object,
	});

test.skipIf(!haveRg)("the route answers the contract shape", async () => {
	const response = await post("demo", { query: "readme" });
	expect(response.statusCode).toBe(200);
	expect(response.json()).toEqual({ paths: ["README.md"], truncated: false });
});

test.skipIf(!haveRg)("the route refuses a request the contract refuses", async () => {
	for (const body of [
		{},
		{ query: "x".repeat(201) },
		{ query: "x", limit: 0 },
		{ query: "x", limit: MAX_FILE_NAME_MATCHES + 1 },
		{ query: 5 },
	]) {
		const response = await post("demo", body);
		expect(response.statusCode).toBe(400);
	}
});

test.skipIf(!haveRg)("the route defaults the limit to twenty", async () => {
	for (let i = 0; i < 25; i += 1)
		await put(`many/file-${String(i).padStart(2, "0")}.txt`);
	const response = await post("demo", { query: "file-" });
	expect(response.json().paths).toHaveLength(20);
	expect(response.json().truncated).toBe(true);
});

test.skipIf(!haveRg)("the route needs the agent token and a real project", async () => {
	expect((await post("demo", { query: "x" }, null)).statusCode).toBe(401);
	expect((await post("demo", { query: "x" }, "b".repeat(64))).statusCode).toBe(401);
	expect((await post("nope", { query: "x" })).statusCode).toBe(404);
	expect((await post("Not A Slug", { query: "x" })).statusCode).toBeGreaterThanOrEqual(
		400,
	);
});

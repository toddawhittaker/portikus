import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { searchProject } from "./search.js";
import { buildServer } from "./server.js";
import { AgentFailure } from "./tmux.js";

const run = promisify(execFile);

const TOKEN = "a".repeat(64);

let app: FastifyInstance;
let homeDir: string;
let projectDir: string;

// skipIf is evaluated at collection time, so probe ripgrep here.
const haveRg = await (async () => {
	try {
		await run("rg", ["--version"]);
		return true;
	} catch {
		return false;
	}
})();

beforeAll(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-search-"));
	projectDir = join(homeDir, "projects", "demo");
	await mkdir(projectDir, { recursive: true });
	const tokenPath = join(homeDir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });

	await writeFile(
		join(projectDir, "main.txt"),
		["above", "call a.b( here", "below", "axb( decoy", "aXbX plain"].join("\n"),
	);
	// ripgrep only honours .gitignore inside a repository.
	await mkdir(join(projectDir, ".git"), { recursive: true });
	await writeFile(join(projectDir, ".gitignore"), "secret.txt\n");
	await writeFile(join(projectDir, "secret.txt"), "call a.b( hidden\n");

	// A file with more lines than one search will return.
	const bulk = Array.from({ length: 501 }, () => "needle").join("\n");
	await mkdir(join(projectDir, "bulk"), { recursive: true });
	for (let file = 0; file < 11; file += 1) {
		await writeFile(join(projectDir, "bulk", `f${file}.txt`), `${bulk}\n`);
	}

	app = buildServer({ tokenPath, homeDir });
	await app.ready();
});

afterAll(async () => {
	await app.close();
	await rm(homeDir, { recursive: true, force: true });
});

test.skipIf(!haveRg)("matches the query literally, not as a regex", async () => {
	const result = await searchProject(homeDir, "demo", "a.b(", { hidden: false });
	expect(result.truncated).toBe(false);
	expect(result.matches).toHaveLength(1);
	const match = result.matches[0];
	expect(match?.path).toBe("main.txt");
	expect(match?.line).toBe(2);
	expect(match?.column).toBe(6);
	expect(match?.text).toBe("call a.b( here");
});

test.skipIf(!haveRg)("returns one line of context on each side", async () => {
	const result = await searchProject(homeDir, "demo", "a.b(", { hidden: false });
	expect(result.matches[0]?.before).toEqual(["above"]);
	expect(result.matches[0]?.after).toEqual(["below"]);
});

test.skipIf(!haveRg)("skips ignored files unless hidden is asked for", async () => {
	const plain = await searchProject(homeDir, "demo", "a.b(", { hidden: false });
	expect(plain.matches.map((match) => match.path)).toEqual(["main.txt"]);

	const withHidden = await searchProject(homeDir, "demo", "a.b(", { hidden: true });
	expect(withHidden.matches.map((match) => match.path).sort()).toEqual([
		"main.txt",
		"secret.txt",
	]);
});

test.skipIf(!haveRg)("stops at the match limit and reports truncation", async () => {
	const result = await searchProject(homeDir, "demo", "needle", { hidden: false });
	expect(result.matches).toHaveLength(500);
	expect(result.truncated).toBe(true);
});

test.skipIf(!haveRg)("aborting the signal kills ripgrep", async () => {
	const controller = new AbortController();
	let child: { killed: boolean } | undefined;
	const pending = searchProject(homeDir, "demo", "needle", {
		hidden: false,
		signal: controller.signal,
		onChild: (spawned) => {
			child = spawned;
			// Abort once the search has attached its abort listener.
			setImmediate(() => controller.abort());
		},
	});
	await pending;
	expect(child?.killed).toBe(true);
});

test.skipIf(!haveRg)("no match is an empty result, not an error", async () => {
	const result = await searchProject(homeDir, "demo", "zzz-nothing-here", {
		hidden: false,
	});
	expect(result).toEqual({ matches: [], truncated: false });
});

test.skipIf(!haveRg)("an unknown project is not found", async () => {
	await expect(searchProject(homeDir, "nope", "a", { hidden: false })).rejects.toThrow(
		AgentFailure,
	);
	await expect(
		searchProject(homeDir, "nope", "a", { hidden: false }),
	).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
});

test.skipIf(!haveRg)("the route returns matches", async () => {
	const response = await app.inject({
		method: "GET",
		url: "/projects/demo/search?q=a.b(",
		headers: { authorization: `Bearer ${TOKEN}` },
	});
	expect(response.statusCode).toBe(200);
	const body = response.json() as { matches: { path: string }[]; truncated: boolean };
	expect(body.matches.map((match) => match.path)).toEqual(["main.txt"]);
	expect(body.truncated).toBe(false);
});

test("the route rejects a search with no query", async () => {
	const response = await app.inject({
		method: "GET",
		url: "/projects/demo/search",
		headers: { authorization: `Bearer ${TOKEN}` },
	});
	expect(response.statusCode).toBe(400);
	expect(response.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
});

test("the route reports an unknown project", async () => {
	const response = await app.inject({
		method: "GET",
		url: "/projects/missing/search?q=x",
		headers: { authorization: `Bearer ${TOKEN}` },
	});
	expect(response.statusCode).toBe(404);
	expect(response.json()).toMatchObject({ error: { code: "PROJECT_NOT_FOUND" } });
});

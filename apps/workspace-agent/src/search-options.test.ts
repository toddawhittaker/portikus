/**
 * Search options (SPEC.md §11.5): case, whole word, and regular expression,
 * each mapped to a ripgrep flag, with a refused pattern reported as the
 * student's mistake rather than a server fault.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PATTERN_INVALID_MESSAGE } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { AgentFailure } from "./errors.js";
import { searchArgs, searchProject } from "./search.js";
import { buildServer } from "./server.js";

const run = promisify(execFile);
const TOKEN = "b".repeat(64);
const SLUG = "opts";

let app: FastifyInstance;
let homeDir: string;

const haveRg = await (async () => {
	try {
		await run("rg", ["--version"]);
		return true;
	} catch {
		return false;
	}
})();

beforeAll(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-search-opts-"));
	const project = join(homeDir, "projects", SLUG);
	await mkdir(project, { recursive: true });
	const tokenPath = join(homeDir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	await writeFile(
		join(project, "words.txt"),
		["Foo stands alone", "foobar joined", "a .*literal star", "--pre=sh flag"].join(
			"\n",
		),
	);
	app = buildServer({ tmuxSocketName: "portikus-test", tokenPath, homeDir });
	await app.ready();
});

afterAll(async () => {
	await app.close();
	await rm(homeDir, { recursive: true, force: true });
});

const OFF = { hidden: false };

function lines(result: { matches: { line: number }[] }): number[] {
	return result.matches.map((match) => match.line).sort();
}

test("every combination maps to fixed flags and never to PCRE2", () => {
	for (const regex of [false, true]) {
		for (const caseSensitive of [false, true]) {
			for (const wholeWord of [false, true]) {
				const args = searchArgs({ hidden: false, regex, caseSensitive, wholeWord });
				expect(args).not.toContain("-P");
				expect(args).not.toContain("--pcre2");
				expect(args.includes("-F")).toBe(!regex);
				expect(args).toContain(caseSensitive ? "-s" : "-i");
				expect(args.includes("-w")).toBe(wholeWord);
			}
		}
	}
});

test.skipIf(!haveRg)("with every option off the search ignores case", async () => {
	expect(lines(await searchProject(homeDir, SLUG, "FOO", OFF))).toEqual([1, 2]);
});

test.skipIf(!haveRg)("match case finds only the exact case", async () => {
	const options = { ...OFF, caseSensitive: true };
	expect(lines(await searchProject(homeDir, SLUG, "Foo", options))).toEqual([1]);
	expect(lines(await searchProject(homeDir, SLUG, "FOO", options))).toEqual([]);
});

test.skipIf(!haveRg)("whole word skips a match inside a longer word", async () => {
	const options = { ...OFF, wholeWord: true };
	expect(lines(await searchProject(homeDir, SLUG, "foo", options))).toEqual([1]);
});

test.skipIf(!haveRg)("a regular expression matches as a pattern", async () => {
	const result = await searchProject(homeDir, SLUG, "o+b", { ...OFF, regex: true });
	expect(lines(result)).toEqual([2]);
	// The highlight covers the match, not the length of the query text.
	expect(result.matches[0]).toMatchObject({ column: 2, length: 3 });
});

test.skipIf(!haveRg)("without regex the same text is a literal", async () => {
	expect(lines(await searchProject(homeDir, SLUG, "o+b", OFF))).toEqual([]);
	expect(lines(await searchProject(homeDir, SLUG, ".*literal", OFF))).toEqual([3]);
});

test.skipIf(!haveRg)("a pattern ripgrep refuses is PATTERN_INVALID", async () => {
	const failure = await searchProject(homeDir, SLUG, "(", {
		...OFF,
		regex: true,
	}).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(AgentFailure);
	expect((failure as AgentFailure).code).toBe("PATTERN_INVALID");
	expect((failure as AgentFailure).message).toBe(PATTERN_INVALID_MESSAGE);
	// The same text as a literal is just a search with no match.
	expect(lines(await searchProject(homeDir, SLUG, "(", OFF))).toEqual([]);
});

test.skipIf(!haveRg)(
	"a query that looks like a flag is still only a pattern",
	async () => {
		for (const regex of [false, true]) {
			const result = await searchProject(homeDir, SLUG, "--pre=sh", { ...OFF, regex });
			expect(lines(result)).toEqual([4]);
		}
	},
);

test.skipIf(!haveRg)("the route answers a refused pattern with 400", async () => {
	const response = await app.inject({
		method: "GET",
		url: `/projects/${SLUG}/search?q=${encodeURIComponent("(")}&regex=true`,
		headers: { authorization: `Bearer ${TOKEN}` },
	});
	expect(response.statusCode).toBe(400);
	expect(response.json()).toEqual({
		error: { code: "PATTERN_INVALID", message: PATTERN_INVALID_MESSAGE },
	});
});

test("the route rejects an option that is not true or false", async () => {
	for (const name of ["regex", "caseSensitive", "wholeWord"]) {
		const response = await app.inject({
			method: "GET",
			url: `/projects/${SLUG}/search?q=foo&${name}=yes`,
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(response.statusCode).toBe(400);
	}
});

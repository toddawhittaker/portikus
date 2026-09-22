import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { buildServer } from "../server.js";

/**
 * Path spellings sent straight to the agent, as a hostile or buggy caller
 * would, across every file operation (SPEC.md §11.1, §24.6; Epic 12a Done
 * item 7). files.test.ts already covers plain `..`, absolute paths, a
 * backslash, `.`, a NUL on read, and single symlinks on read and write; this
 * file covers the encoded spellings and the operations those tests skip.
 *
 * The invariant is the same for every case: nothing outside the selected
 * project changes, no answer carries outside content, and nothing is a 500.
 */

const run = promisify(execFile);
const TOKEN = "c".repeat(64);
const SECRET = "OUTSIDE-SECRET";

async function available(command: string, args: string[]): Promise<boolean> {
	try {
		await run(command, args);
		return true;
	} catch {
		return false;
	}
}

const haveGit = await available("git", ["--version"]);
const haveZip = (await available("zip", ["-v"])) && (await available("unzip", ["-v"]));
const haveRg = await available("rg", ["--version"]);

let app: FastifyInstance;
let homeDir: string;
let project: string;

beforeAll(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-escape-"));
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
	const projectsRoot = join(homeDir, "projects");
	await rm(projectsRoot, { recursive: true, force: true });
	await rm(join(homeDir, "outside"), { recursive: true, force: true });
	project = join(projectsRoot, "alpha");
	await mkdir(join(project, "sub"), { recursive: true });
	await writeFile(join(project, "notes.txt"), "inside");
	await mkdir(join(projectsRoot, "beta"), { recursive: true });
	await writeFile(join(projectsRoot, "beta", "secret.txt"), SECRET);
	await mkdir(join(homeDir, "outside"), { recursive: true });
	await writeFile(join(homeDir, "outside", "secret.txt"), SECRET);
	await writeFile(join(homeDir, "outside.txt"), SECRET);
	if (haveGit) {
		await run("git", ["init", "-q", project]);
	}
});

/** Every entry under the home except the selected project, with content. */
async function outsideSnapshot(): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	async function walk(dir: string): Promise<void> {
		for (const name of await readdir(dir)) {
			const full = join(dir, name);
			if (full === project) continue;
			const info = await lstat(full);
			const key = relative(homeDir, full);
			if (info.isSymbolicLink()) {
				result[key] = `link:${await readlink(full)}`;
			} else if (info.isDirectory()) {
				result[key] = "dir";
				await walk(full);
			} else {
				const hash = createHash("sha256").update(await readFile(full));
				result[key] = `file:${hash.digest("hex")}`;
			}
		}
	}
	await walk(homeDir);
	return result;
}

interface Answer {
	status: number;
	body: Buffer;
}

async function call(
	method: "GET" | "PUT" | "DELETE" | "POST",
	url: string,
	extra: { payload?: unknown; headers?: Record<string, string> } = {},
): Promise<Answer> {
	const response = await app.inject({
		method,
		url,
		headers: { authorization: `Bearer ${TOKEN}`, ...extra.headers },
		payload: extra.payload as string | undefined,
	});
	return { status: response.statusCode, body: response.rawPayload };
}

/** The raw query value decoded once, as a JSON body would carry it. */
function decoded(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** Every operation that takes a path, called with one spelling. */
async function everyOperation(slug: string, raw: string): Promise<[string, Answer][]> {
	const base = `/projects/${slug}`;
	const body = decoded(raw);
	const json = { "content-type": "application/json" };
	return [
		["tree", await call("GET", `${base}/tree?path=${raw}`)],
		["read", await call("GET", `${base}/file?path=${raw}`)],
		["download", await call("GET", `${base}/file?path=${raw}&download=1`)],
		[
			"write",
			await call("PUT", `${base}/file?path=${raw}`, {
				payload: "pwned",
				headers: { "content-type": "text/plain", "if-none-match": "*" },
			}),
		],
		[
			"overwrite",
			await call("PUT", `${base}/file?path=${raw}`, {
				payload: "pwned",
				headers: { "content-type": "text/plain", "if-match": "*" },
			}),
		],
		["archive", await call("GET", `${base}/archive?path=${raw}`)],
		["git diff", await call("GET", `${base}/git/diff?path=${raw}`)],
		[
			"baseline diff",
			await call("GET", `${base}/baseline-diff?object=${"0".repeat(40)}&path=${raw}`),
		],
		[
			"mkdir",
			await call("POST", `${base}/mkdir`, {
				payload: JSON.stringify({ path: body }),
				headers: json,
			}),
		],
		[
			"move target",
			await call("POST", `${base}/move`, {
				payload: JSON.stringify({ from: "notes.txt", to: body }),
				headers: json,
			}),
		],
		[
			"move source",
			await call("POST", `${base}/move`, {
				payload: JSON.stringify({ from: body, to: "moved.txt" }),
				headers: json,
			}),
		],
		// Delete last, so a spelling that names something real inside the
		// project has been through every other operation first.
		["delete", await call("DELETE", `${base}/file?path=${raw}`)],
	];
}

/** Nothing outside the project leaked, changed, or crashed the agent. */
async function expectConfined(
	answers: [string, Answer][],
	before: Record<string, string>,
	refused: boolean,
): Promise<void> {
	for (const [operation, answer] of answers) {
		expect(answer.status, operation).toBeLessThan(500);
		expect(answer.body.includes(SECRET), operation).toBe(false);
		if (refused) {
			expect(answer.status, operation).toBe(400);
		}
	}
	expect(await outsideSnapshot()).toEqual(before);
}

// [name, raw query value, whether it decodes to a traversal and must be a 400]
const SPELLINGS: Array<[string, string, boolean]> = [
	["percent-encoded ..", "%2e%2e%2fbeta%2fsecret.txt", true],
	["upper-case percent-encoded ..", "%2E%2E%2Fbeta%2Fsecret.txt", true],
	["mixed-case percent-encoded ..", "%2E%2e/beta/secret.txt", true],
	["an encoded slash after ..", "..%2fbeta%2fsecret.txt", true],
	["an encoded backslash", "..%5cbeta%5csecret.txt", true],
	["an encoded absolute path", "%2fetc%2fpasswd", true],
	["a double slash absolute path", "//etc/passwd", true],
	["a nested encoded ..", "sub%2f..%2f..%2fbeta", true],
	["a trailing ..", "sub/..", true],
	["a trailing ../", "..%2f", true],
	["a NUL after a traversal", "..%2fbeta%00", true],
	["a NUL before an extension", "notes.txt%00.png", true],
	["a thousand ../ segments", "..%2f".repeat(300), true],
	["a path past 1024 characters", "a/".repeat(600), true],
	// These decode to names that are not traversals, so they may succeed,
	// but only as literal names inside the project.
	["double-encoded ..", "%252e%252e%252fbeta%252fsecret.txt", false],
	["double-encoded backslash", "..%255cbeta", false],
	["overlong UTF-8 dots and slash", "%c0%ae%c0%ae%c0%afbeta%c0%afsecret.txt", false],
	["three-byte overlong dots", "%e0%80%ae%e0%80%ae/beta/secret.txt", false],
	[
		"full-width dots and slash",
		"%ef%bc%8e%ef%bc%8e%ef%bc%8fbeta%ef%bc%8fsecret.txt",
		false,
	],
	["full-width dots with a real slash", "%ef%bc%8e%ef%bc%8e/beta/secret.txt", false],
	["a full-width reverse solidus", "..%ef%bc%bcbeta", false],
	["three dots", ".../beta/secret.txt", false],
	["trailing dots on a name", "notes.txt..", false],
	["a trailing slash on a file", "notes.txt/", false],
	["a single 255-byte name", "n".repeat(255), false],
	["a name past NAME_MAX", "n".repeat(300), false],
	["deeply nested missing directories", "d/".repeat(400).slice(0, -1), false],
];

for (const [name, raw, refused] of SPELLINGS) {
	test(`${name} stays inside the project on every operation`, async () => {
		const before = await outsideSnapshot();
		await expectConfined(await everyOperation("alpha", raw), before, refused);
	});
}

test("a repeated path parameter is refused on every query operation", async () => {
	const before = await outsideSnapshot();
	const raw = "notes.txt&path=..%2fbeta%2fsecret.txt";
	const answers = (await everyOperation("alpha", raw)).filter(
		([operation]) => !operation.startsWith("m"),
	);
	for (const [operation, answer] of answers) {
		expect(answer.status, operation).toBe(400);
	}
	await expectConfined(answers, before, true);
});

// --- Symlinks ---------------------------------------------------------------

test("a symlinked directory mid-path is refused on every operation", async () => {
	await symlink(join(homeDir, "outside"), join(project, "link"));
	const before = await outsideSnapshot();
	const answers = await everyOperation("alpha", "link/secret.txt");
	// The link itself sits in the project, so moving or deleting the
	// directory link is fine; everything through it is refused.
	await expectConfined(answers, before, true);
});

test("a symlink loop fails closed on every operation", async () => {
	await symlink("loop", join(project, "loop"));
	await symlink("b", join(project, "a"));
	await symlink("a", join(project, "b"));
	for (const raw of ["loop", "loop/x", "a/x", "b"]) {
		const before = await outsideSnapshot();
		await expectConfined(await everyOperation("alpha", raw), before, false);
	}
});

test("a symlink loop mid-path is a 400, not a hang or a 500", async () => {
	await symlink("loop", join(project, "loop"));
	const answer = await call("GET", "/projects/alpha/file?path=loop%2Fx");
	expect(answer.status).toBe(400);
	expect(JSON.parse(answer.body.toString()).error.code).toBe("PATH_INVALID");
});

test("a project directory that is a symlink out of ~/projects is refused", async () => {
	await symlink(join(homeDir, "outside"), join(homeDir, "projects", "linked"));
	const before = await outsideSnapshot();
	const answers = await everyOperation("linked", "secret.txt");
	await expectConfined(answers, before, true);
	for (const [operation, answer] of answers) {
		expect(JSON.parse(answer.body.toString()).error.code, operation).toBe(
			"INVALID_SLUG",
		);
	}
});

test("a project directory that is a symlink to a sibling project is refused", async () => {
	await symlink(join(homeDir, "projects", "beta"), join(homeDir, "projects", "gamma"));
	const before = await outsideSnapshot();
	await expectConfined(await everyOperation("gamma", "secret.txt"), before, true);
});

test.skipIf(!haveRg)("search never follows a symlink out of the project", async () => {
	await symlink(join(homeDir, "outside"), join(project, "outside-dir"));
	await symlink(join(homeDir, "outside.txt"), join(project, "outside-file"));
	await symlink(join(homeDir, "projects", "beta"), join(project, "sibling"));
	for (const hidden of ["false", "true"]) {
		const answer = await call(
			"GET",
			`/projects/alpha/search?q=${SECRET}&hidden=${hidden}`,
		);
		expect(answer.status).toBe(200);
		expect(JSON.parse(answer.body.toString()).results ?? []).toEqual([]);
		expect(answer.body.includes(SECRET)).toBe(false);
	}
});

test.skipIf(!haveZip)(
	"a project archive stores an outward symlink as a link",
	async () => {
		await symlink(join(homeDir, "outside.txt"), join(project, "outside-file"));
		await symlink(join(homeDir, "outside"), join(project, "outside-dir"));
		const answer = await call("GET", "/projects/alpha/archive");
		// Stored as links, the archive holds their target paths but never the
		// content behind them, and no entry from inside the linked directory.
		expect(answer.body.includes(SECRET)).toBe(false);
		expect(answer.body.includes("outside-dir/secret.txt")).toBe(false);
	},
);

test.skipIf(!haveZip)(
	"a project holding a symlink downloads as a complete archive (SPEC.md §11.2, #400)",
	async () => {
		await symlink("notes.txt", join(project, "inside-link"));
		const answer = await call("GET", "/projects/alpha/archive");
		const zipPath = join(homeDir, "linked.zip");
		await writeFile(zipPath, answer.body);
		try {
			const { stdout } = await run("unzip", ["-Z1", zipPath]);
			expect(stdout).toContain("alpha/inside-link");
		} finally {
			await rm(zipPath);
		}
	},
);

test.skipIf(!haveZip)(
	"an outward symlink downloads as a valid zip holding the link, not its target",
	async () => {
		const target = join(homeDir, "outside.txt");
		await symlink(target, join(project, "outside-file"));
		const answer = await call("GET", "/projects/alpha/archive");
		expect(answer.status).toBe(200);
		const zipPath = join(homeDir, "outward.zip");
		await writeFile(zipPath, answer.body);
		try {
			// A long listing marks a stored symlink with an "l" mode.
			const { stdout: listing } = await run("unzip", ["-Z", zipPath]);
			expect(listing).toMatch(/^l\S+ .*alpha\/outside-file$/m);
			// A link entry's data is its target path, never the target's content.
			const { stdout: data } = await run("unzip", [
				"-p",
				zipPath,
				"alpha/outside-file",
			]);
			expect(data).toBe(target);
			expect(answer.body.includes(SECRET)).toBe(false);
		} finally {
			await rm(zipPath);
		}
	},
);

test.skipIf(!haveGit)(
	"git diff of a symlink out of the project shows no content",
	async () => {
		await symlink(join(homeDir, "outside.txt"), join(project, "outside-file"));
		// A dangling link whose target would be outside, too.
		await symlink(join(homeDir, "gone.txt"), join(project, "dangling"));
		for (const raw of ["outside-file", "dangling"]) {
			const answer = await call("GET", `/projects/alpha/git/diff?path=${raw}`);
			expect(answer.status).toBe(400);
			expect(answer.body.includes(SECRET)).toBe(false);
		}
	},
);

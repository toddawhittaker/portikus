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
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
// @ts-expect-error apps/api does not depend on the agent package; the vitest
// alias in vitest.config.ts resolves it from source for this test only.
import { buildServer as buildAgentServer } from "@portikus/workspace-agent";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/**
 * File operations through the API, in front of two REAL agents with separate
 * homes, reach only the caller's selected project (SPEC.md §11.1, §24.6;
 * Epic 12a Done item 7). Student A owns projects alpha and beta; student B
 * owns a project also called alpha, in another home. Every spelling is sent
 * raw, so nothing between the browser and the agent decodes it twice.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const skip = !hasTestDb();
const SECRET = "OUTSIDE-SECRET";
const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

interface Agent {
	app: FastifyInstance;
	home: string;
	token: string;
	address: string;
	/** Every URL the agent was asked for since the last reset. */
	calls: string[];
}

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let agentA: Agent;
let agentB: Agent;
let alice: CookieJar;
let bob: CookieJar;
let workspaceA: string;
let alphaA: string;
let linkedA: string;
let agentPort: number;

async function startAgent(
	address: string,
	token: string,
	port: number,
): Promise<Agent> {
	const home = await mkdtemp(join(tmpdir(), "portikus-escape-home-"));
	const tokenPath = join(home, "agent.token");
	await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
	const agentApp = buildAgentServer({ tokenPath, homeDir: home }) as FastifyInstance;
	const agent: Agent = { app: agentApp, home, token, address, calls: [] };
	agentApp.addHook("onRequest", async (request) => {
		// The listening registry's own background socket is not a file
		// operation; leave it out so it cannot be mistaken for one.
		if (request.url.startsWith("/listening/events")) return;
		agent.calls.push(request.url);
	});
	await agentApp.listen({ port, host: address });
	return agent;
}

/** A's project directory that operations are meant to reach. */
function alphaDir(): string {
	return join(agentA.home, "projects", "alpha");
}

async function makeRunningWorkspace(jar: CookieJar, agent: Agent): Promise<string> {
	const id = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(jar, PUBLIC_URL),
		})
	).json().id;
	await testDb.db
		.updateTable("workspaces")
		.set({
			state: "running",
			agent_address: agent.address,
			agent_token: agent.token,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", id)
		.execute();
	return id;
}

async function createProject(jar: CookieJar, workspaceId: string, name: string) {
	const response = await app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/projects`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: { name, source: "new", gitInit: true },
	});
	expect(response.statusCode).toBe(201);
	return response.json().id as string;
}

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
	// The API reaches every agent on one port, so the two agents share a
	// port on two loopback addresses, as two workspaces share 7400.
	agentA = await startAgent("127.0.0.1", TOKEN_A, 0);
	agentPort = (agentA.app.server.address() as AddressInfo).port;
	agentB = await startAgent("127.0.0.2", TOKEN_B, agentPort);
});

afterAll(async () => {
	if (skip) return;
	for (const agent of [agentA, agentB]) {
		await agent.app.close();
		await rm(agent.home, { recursive: true, force: true });
	}
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	for (const agent of [agentA, agentB]) {
		await rm(join(agent.home, "projects"), { recursive: true, force: true });
		await rm(join(agent.home, "outside"), { recursive: true, force: true });
		await mkdir(join(agent.home, "outside"), { recursive: true });
		await writeFile(join(agent.home, "outside", "secret.txt"), SECRET);
		await writeFile(join(agent.home, "outside.txt"), SECRET);
	}
	await testDb.truncate();
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agentPort });
	await app.ready();
	alice = new CookieJar();
	bob = new CookieJar();
	await loginAs(app, "alice", alice);
	await loginAs(app, "bob", bob);
	workspaceA = await makeRunningWorkspace(alice, agentA);
	const workspaceB = await makeRunningWorkspace(bob, agentB);
	alphaA = await createProject(alice, workspaceA, "alpha");
	await createProject(alice, workspaceA, "beta");
	linkedA = await createProject(alice, workspaceA, "linked");
	await createProject(bob, workspaceB, "alpha");
	await mkdir(join(alphaDir(), "sub"));
	await writeFile(join(alphaDir(), "notes.txt"), "inside");
	await writeFile(join(agentA.home, "projects", "beta", "secret.txt"), SECRET);
	await writeFile(join(agentB.home, "projects", "alpha", "secret.txt"), SECRET);
	agentA.calls.length = 0;
	agentB.calls.length = 0;
	return async () => {
		await app.close();
	};
});

/** Every entry in both homes except A's alpha project, with content. */
async function outsideSnapshot(): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	async function walk(root: string, dir: string): Promise<void> {
		for (const name of await readdir(dir)) {
			const full = join(dir, name);
			if (full === alphaDir()) continue;
			const info = await lstat(full);
			const key = `${root === agentA.home ? "A" : "B"}:${relative(root, full)}`;
			if (info.isSymbolicLink()) {
				result[key] = `link:${await readlink(full)}`;
			} else if (info.isDirectory()) {
				result[key] = "dir";
				await walk(root, full);
			} else {
				const hash = createHash("sha256").update(await readFile(full));
				result[key] = `file:${hash.digest("hex")}`;
			}
		}
	}
	await walk(agentA.home, agentA.home);
	await walk(agentB.home, agentB.home);
	return result;
}

interface Answer {
	status: number;
	body: Buffer;
}

async function call(
	method: "GET" | "PUT" | "DELETE" | "POST",
	url: string,
	extra: { payload?: string; headers?: Record<string, string> } = {},
): Promise<Answer> {
	const response = await app.inject({
		method,
		url,
		headers: { ...csrfHeaders(alice, PUBLIC_URL), ...extra.headers },
		payload: extra.payload,
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

/** Every API operation that takes a path, called with one raw spelling. */
async function everyOperation(
	projectId: string,
	raw: string,
): Promise<[string, Answer][]> {
	const base = `/workspaces/${workspaceA}/projects/${projectId}`;
	const body = decoded(raw);
	const json = { "content-type": "application/json" };
	return [
		["tree", await call("GET", `${base}/tree?path=${raw}`)],
		["read", await call("GET", `${base}/file?path=${raw}`)],
		["file download", await call("GET", `${base}/file?path=${raw}&download=1`)],
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
		["folder download", await call("GET", `${base}/download?path=${raw}`)],
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
		["delete", await call("DELETE", `${base}/file?path=${raw}`)],
	];
}

/** Nothing outside A's alpha leaked, changed, or broke the API. */
async function expectConfined(
	answers: [string, Answer][],
	before: Record<string, string>,
): Promise<void> {
	for (const [operation, answer] of answers) {
		expect(answer.status, operation).toBeLessThan(500);
		expect(answer.body.includes(SECRET), operation).toBe(false);
	}
	// B's agent is never asked for anything on A's behalf.
	expect(agentB.calls).toEqual([]);
	expect(await outsideSnapshot()).toEqual(before);
}

// [name, raw query value] for spellings that decode to a traversal: the API
// refuses them itself, so the agent is never called.
const REFUSED: Array<[string, string]> = [
	["percent-encoded ..", "%2e%2e%2fbeta%2fsecret.txt"],
	["upper-case percent-encoded ..", "%2E%2E%2Fbeta%2Fsecret.txt"],
	["mixed-case percent-encoded ..", "%2E%2e/beta/secret.txt"],
	["an encoded slash after ..", "..%2fbeta%2fsecret.txt"],
	["an encoded backslash", "..%5cbeta%5csecret.txt"],
	["an encoded absolute path", "%2fetc%2fpasswd"],
	["a double slash absolute path", "//etc/passwd"],
	["a nested encoded ..", "sub%2f..%2f..%2fbeta"],
	["a trailing ..", "sub/.."],
	["a trailing ../", "..%2f"],
	["a NUL after a traversal", "..%2fbeta%00"],
	["a NUL before an extension", "notes.txt%00.png"],
	["three hundred ../ segments", "..%2f".repeat(300)],
	["a path past 1024 characters", "a/".repeat(600)],
	["a repeated path parameter", "notes.txt&path=..%2fbeta%2fsecret.txt"],
];

for (const [name, raw] of REFUSED) {
	test.skipIf(skip)(`${name} is refused by the API on every operation`, async () => {
		const before = await outsideSnapshot();
		const answers = await everyOperation(alphaA, raw);
		for (const [operation, answer] of answers) {
			// A repeated parameter cannot reach a JSON body, so mkdir and move
			// see only the first, harmless name.
			if (name.startsWith("a repeated") && /^m/.test(operation)) continue;
			expect(answer.status, operation).toBe(400);
		}
		await expectConfined(answers, before);
		if (!name.startsWith("a repeated")) {
			expect(agentA.calls).toEqual([]);
		}
	});
}

// Spellings that decode to a name, not a traversal. They may succeed, but
// only as that literal name inside A's alpha.
const LITERAL: Array<[string, string]> = [
	["double-encoded ..", "%252e%252e%252fbeta%252fsecret.txt"],
	["double-encoded backslash", "..%255cbeta"],
	["overlong UTF-8 dots and slash", "%c0%ae%c0%ae%c0%afbeta%c0%afsecret.txt"],
	["three-byte overlong dots", "%e0%80%ae%e0%80%ae/beta/secret.txt"],
	["full-width dots and slash", "%ef%bc%8e%ef%bc%8e%ef%bc%8fbeta%ef%bc%8fsecret.txt"],
	["full-width dots with a real slash", "%ef%bc%8e%ef%bc%8e/beta/secret.txt"],
	["a full-width reverse solidus", "..%ef%bc%bcbeta"],
	["three dots", ".../beta/secret.txt"],
	["trailing dots on a name", "notes.txt.."],
	["a trailing slash on a file", "notes.txt/"],
	["a 255-byte name", "n".repeat(255)],
	["a name past NAME_MAX", "n".repeat(300)],
	["deeply nested missing directories", "d/".repeat(400).slice(0, -1)],
];

for (const [name, raw] of LITERAL) {
	test.skipIf(skip)(`${name} stays inside the selected project`, async () => {
		const before = await outsideSnapshot();
		await expectConfined(await everyOperation(alphaA, raw), before);
	});
}

test.skipIf(skip)("a double-encoded .. is written under its literal name", async () => {
	const response = await call(
		"PUT",
		`/workspaces/${workspaceA}/projects/${alphaA}/file?path=%252e%252e%252fbeta`,
		{
			payload: "literal",
			headers: { "content-type": "text/plain", "if-none-match": "*" },
		},
	);
	expect(response.status).toBe(200);
	// Decoded once by the API, re-encoded to the agent, decoded once there.
	expect(await readFile(join(alphaDir(), "%2e%2e%2fbeta"), "utf8")).toBe("literal");
});

test.skipIf(skip)("the same slug in another workspace is never reached", async () => {
	// B's alpha has secret.txt; A's alpha does not.
	const read = await call(
		"GET",
		`/workspaces/${workspaceA}/projects/${alphaA}/file?path=secret.txt`,
	);
	expect(read.status).toBe(404);
	expect(agentB.calls).toEqual([]);
	expect(agentA.calls.length).toBeGreaterThan(0);
});

// --- Symlinks ---------------------------------------------------------------

test.skipIf(skip)(
	"a symlinked directory mid-path is refused on every operation",
	async () => {
		await symlink(join(agentA.home, "outside"), join(alphaDir(), "link"));
		const before = await outsideSnapshot();
		const answers = await everyOperation(alphaA, "link/secret.txt");
		for (const [operation, answer] of answers) {
			expect(answer.status, operation).toBe(400);
		}
		await expectConfined(answers, before);
	},
);

test.skipIf(skip)("a symlink loop fails closed on every operation", async () => {
	await symlink("loop", join(alphaDir(), "loop"));
	await symlink("b", join(alphaDir(), "a"));
	await symlink("a", join(alphaDir(), "b"));
	for (const raw of ["loop", "loop/x", "a/x", "b"]) {
		const before = await outsideSnapshot();
		await expectConfined(await everyOperation(alphaA, raw), before);
	}
});

test.skipIf(skip)(
	"a project directory symlinked into another student's home is refused",
	async () => {
		const linked = join(agentA.home, "projects", "linked");
		await rm(linked, { recursive: true });
		await symlink(join(agentB.home, "projects", "alpha"), linked);
		const before = await outsideSnapshot();
		const answers = await everyOperation(linkedA, "secret.txt");
		for (const [operation, answer] of answers) {
			expect(answer.status, operation).toBe(400);
			expect(JSON.parse(answer.body.toString()).code, operation).toBe("INVALID_SLUG");
		}
		await expectConfined(answers, before);

		const search = await call(
			"GET",
			`/workspaces/${workspaceA}/projects/${linkedA}/search?q=${SECRET}`,
		);
		expect(search.status).toBe(400);
		expect(search.body.includes(SECRET)).toBe(false);
		const zip = await call(
			"GET",
			`/workspaces/${workspaceA}/projects/${linkedA}/download`,
		);
		expect(zip.status).toBe(400);
	},
);

test.skipIf(skip)("search never follows a symlink out of the project", async () => {
	await symlink(join(agentA.home, "outside"), join(alphaDir(), "outside-dir"));
	await symlink(join(agentA.home, "outside.txt"), join(alphaDir(), "outside-file"));
	await symlink(join(agentA.home, "projects", "beta"), join(alphaDir(), "sibling"));
	await symlink(join(agentB.home, "projects", "alpha"), join(alphaDir(), "other-home"));
	for (const hidden of ["false", "true"]) {
		const answer = await call(
			"GET",
			`/workspaces/${workspaceA}/projects/${alphaA}/search?q=${SECRET}&hidden=${hidden}`,
		);
		expect(answer.status).toBe(200);
		expect(answer.body.includes(SECRET)).toBe(false);
	}
});

test.skipIf(skip)(
	"a project download never carries what a symlink points at",
	async () => {
		await symlink(join(agentA.home, "outside.txt"), join(alphaDir(), "outside-file"));
		await symlink(
			join(agentB.home, "projects", "alpha"),
			join(alphaDir(), "other-home"),
		);
		const answer = await call(
			"GET",
			`/workspaces/${workspaceA}/projects/${alphaA}/download`,
		);
		expect(answer.body.includes(SECRET)).toBe(false);
		expect(answer.body.includes("other-home/secret.txt")).toBe(false);
	},
);

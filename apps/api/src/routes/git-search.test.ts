import type { AddressInfo } from "node:net";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import type { GitDiff, GitStatus } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/**
 * The brokered Git and search routes (SPEC.md §11.5, §12.1, §12.6). Only the
 * owner of the workspace gets through, a stopped workspace is a 409, and no
 * path leaves the control plane without being checked (SPEC.md §5.2, §24.6).
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "fake-agent-token";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let workspaceId: string;
let projectId: string;
let slug: string;

const STATUS: GitStatus = {
	repo: true,
	branch: "main",
	detached: false,
	upstream: "origin/main",
	ahead: 1,
	behind: 0,
	conflicts: 0,
	entries: [{ path: "README.md", x: ".", y: "M", unmerged: false }],
	ignored: ["node_modules/"],
	truncated: false,
};

const DIFF: GitDiff = {
	status: "M",
	before: "old\n",
	after: "new\n",
	binary: false,
	tooLarge: false,
};

async function makeWorkspace(jar: CookieJar, running: boolean): Promise<string> {
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
			state: running ? "running" : "stopped",
			agent_address: "127.0.0.1",
			agent_token: AGENT_TOKEN,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", id)
		.execute();
	return id;
}

/** One project row, without needing a running workspace to make it. */
async function makeProject(id: string, name: string): Promise<string> {
	const row = await testDb.db
		.insertInto("projects")
		.values({
			workspace_id: id,
			slug: name,
			name,
			path: `/home/student/projects/${name}`,
			source: "new",
		})
		.returningAll()
		.executeTakeFirstOrThrow();
	return row.id;
}

function get(jar: CookieJar, id: string, pid: string, route: string, query = "") {
	return app.inject({
		method: "GET",
		url: `/workspaces/${id}/projects/${pid}/${route}${query}`,
		headers: { cookie: jar.cookieHeader() },
	});
}

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
	agent = await startFakeAgent(AGENT_TOKEN);
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
	await agent.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	agent.projects.clear();
	agent.files.clear();
	agent.git.clear();
	agent.search.clear();
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
	workspaceId = await makeWorkspace(alice, true);
	slug = "essay";
	projectId = await makeProject(workspaceId, slug);
	agent.projects.set(slug, { isGitRepo: true });
	agent.git.set(`/${slug}`, { status: STATUS, diffs: { "README.md": DIFF } });
	agent.search.set(`/${slug}`, [
		{ path: "README.md", line: 3, column: 5, text: "hello", before: [], after: [] },
	]);
	return async () => {
		await app.close();
	};
});

test.skipIf(skip)("git status comes back for the owner", async () => {
	const response = await get(alice, workspaceId, projectId, "git/status");
	expect(response.statusCode).toBe(200);
	// Ignored paths only when hidden files are shown (SPEC.md §12.1).
	expect(response.json()).toEqual({ ...STATUS, ignored: [] });

	const hidden = await get(alice, workspaceId, projectId, "git/status", "?hidden=true");
	expect(hidden.json().ignored).toEqual(["node_modules/"]);
});

test.skipIf(skip)("a hidden flag the contract rejects is a 400", async () => {
	const response = await get(
		alice,
		workspaceId,
		projectId,
		"git/status",
		"?hidden=yes",
	);
	expect(response.statusCode).toBe(400);
	expect(response.json().code).toBe("VALIDATION_FAILED");
});

test.skipIf(skip)("baseline status and diff come back for the owner", async () => {
	const object = "c".repeat(40);
	const status = await get(
		alice,
		workspaceId,
		projectId,
		"baseline-status",
		`?object=${object}`,
	);
	expect(status.statusCode).toBe(200);
	expect(status.json()).toEqual(STATUS);

	const diff = await get(
		alice,
		workspaceId,
		projectId,
		"baseline-diff",
		`?object=${object}&path=README.md`,
	);
	expect(diff.statusCode).toBe(200);
	expect(diff.json()).toEqual(DIFF);

	const missing = await get(alice, workspaceId, projectId, "baseline-status");
	expect(missing.statusCode).toBe(400);
	const escaped = await get(
		alice,
		workspaceId,
		projectId,
		"baseline-diff",
		`?object=${object}&path=../../etc/passwd`,
	);
	expect(escaped.statusCode).toBe(400);
});

test.skipIf(skip)("git diff comes back for the owner", async () => {
	const response = await get(
		alice,
		workspaceId,
		projectId,
		"git/diff",
		"?path=README.md",
	);
	expect(response.statusCode).toBe(200);
	expect(response.json()).toEqual(DIFF);
});

test.skipIf(skip)("a diff of an unknown path is a 404", async () => {
	const response = await get(
		alice,
		workspaceId,
		projectId,
		"git/diff",
		"?path=nope.md",
	);
	expect(response.statusCode).toBe(404);
	expect(response.json().code).toBe("FILE_NOT_FOUND");
});

test.skipIf(skip)("search comes back for the owner", async () => {
	const response = await get(alice, workspaceId, projectId, "search", "?q=hello");
	expect(response.statusCode).toBe(200);
	expect(response.json()).toEqual({
		matches: [
			{ path: "README.md", line: 3, column: 5, text: "hello", before: [], after: [] },
		],
		truncated: false,
	});
});

test.skipIf(skip)("an empty or control-character query is a 400", async () => {
	expect((await get(alice, workspaceId, projectId, "search", "?q=")).statusCode).toBe(
		400,
	);
	const control = await get(alice, workspaceId, projectId, "search", "?q=a%00b");
	expect(control.statusCode).toBe(400);
});

test.skipIf(skip)("a traversal path is refused before the request leaves", async () => {
	// The fake agent would have to be asked for it to have seen anything.
	const response = await get(
		alice,
		workspaceId,
		projectId,
		"git/diff",
		"?path=../../etc/passwd",
	);
	expect(response.statusCode).toBe(400);
	expect(response.json().code).toBe("VALIDATION_FAILED");
});

test.skipIf(skip)("another student gets a 404 on all three", async () => {
	const bob = new CookieJar();
	await loginAs(app, "bob", bob);
	const object = "a".repeat(40);
	for (const route of [
		"git/status",
		"git/diff?path=README.md",
		"search?q=hello",
		`baseline-status?object=${object}`,
		`baseline-diff?object=${object}&path=README.md`,
	]) {
		const response = await get(bob, workspaceId, projectId, route);
		expect(response.statusCode).toBe(404);
		expect(response.json().code).toBe("WORKSPACE_NOT_FOUND");
	}
});

test.skipIf(skip)("a stopped workspace answers 409 on all three", async () => {
	// A student has one workspace, so this is the same one, stopped.
	await testDb.db
		.updateTable("workspaces")
		.set({ state: "stopped", updated_at: new Date().toISOString() })
		.where("id", "=", workspaceId)
		.execute();

	const object = "a".repeat(40);
	for (const route of [
		"git/status",
		"git/diff?path=README.md",
		"search?q=hello",
		`baseline-status?object=${object}`,
		`baseline-diff?object=${object}&path=README.md`,
	]) {
		const response = await get(alice, workspaceId, projectId, route);
		expect(response.statusCode).toBe(409);
		expect(response.json().code).toBe("AGENT_UNAVAILABLE");
	}
});

test.skipIf(skip)(
	"a git command that takes most of the agent's budget still answers",
	async () => {
		// The agent allows GIT_TIMEOUT_MS per command, so the control plane must
		// wait at least that long rather than giving up at its own 5 s.
		const slowSlug = "slow-essay";
		const slowId = await makeProject(workspaceId, slowSlug);
		agent.projects.set(slowSlug, { isGitRepo: true });
		agent.git.set(`/${slowSlug}`, {
			status: STATUS,
			diffs: { "README.md": DIFF },
		});

		const status = await get(alice, workspaceId, slowId, "git/status");
		expect(status.statusCode).toBe(200);
		expect(status.json()).toEqual({ ...STATUS, ignored: [] });

		const diff = await get(alice, workspaceId, slowId, "git/diff", "?path=README.md");
		expect(diff.statusCode).toBe(200);
		expect(diff.json()).toEqual(DIFF);
	},
	30_000,
);

test.skipIf(skip)("an answer the contract rejects is a 503", async () => {
	// The agent sent something that is not a GitStatus at all.
	agent.git.set(`/${slug}`, {
		status: { repo: "yes" } as unknown as GitStatus,
	});
	const response = await get(alice, workspaceId, projectId, "git/status");
	expect(response.statusCode).toBe(503);
	expect(response.json().code).toBe("AGENT_UNAVAILABLE");
});

test.skipIf(skip)("a cancelled search cancels it at the agent too", async () => {
	const before = agent.searchAborted;
	const address = app.server.address() as AddressInfo;
	const controller = new AbortController();
	const pending = fetch(
		`http://127.0.0.1:${address.port}/workspaces/${workspaceId}/projects/${projectId}/search?q=slow`,
		{ headers: { cookie: alice.cookieHeader() }, signal: controller.signal },
	);
	// Give the request time to reach the fake agent before hanging up.
	await new Promise((resolve) => setTimeout(resolve, 200));
	controller.abort();
	await expect(pending).rejects.toThrow();

	await expect
		.poll(() => agent.searchAborted, { timeout: 5000 })
		.toBeGreaterThan(before);
});

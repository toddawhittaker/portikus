import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { MAX_FILE_NAME_MATCHES } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

/**
 * The brokered file-name search behind the composer's `@` menu (SPEC.md §11.1,
 * §24.6). Only the owner of the workspace gets through, a stopped workspace is
 * a 409, and a request the contract refuses never leaves the control plane.
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

async function makeWorkspace(jar: CookieJar): Promise<string> {
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
			agent_address: "127.0.0.1",
			agent_token: AGENT_TOKEN,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", id)
		.execute();
	return id;
}

/** Calls that reached the agent's file search; its background sockets do not count. */
const searchCalls = () =>
	agent.requests.filter((one) => one.url.includes("file-search"));

function search(jar: CookieJar, id: string, pid: string, body: unknown) {
	return app.inject({
		method: "POST",
		url: `/workspaces/${id}/projects/${pid}/file-search`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: body as object,
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
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
	workspaceId = await makeWorkspace(alice);
	const row = await testDb.db
		.insertInto("projects")
		.values({
			workspace_id: workspaceId,
			slug: "essay",
			name: "essay",
			path: "/home/student/projects/essay",
			source: "new",
		})
		.returningAll()
		.executeTakeFirstOrThrow();
	projectId = row.id;
	agent.projects.set("essay", { isGitRepo: false });
	agent.files.set("essay/README.md", { type: "file", content: Buffer.from("x") });
	agent.files.set("essay/src", { type: "dir" });
	agent.files.set("essay/src/Composer.tsx", {
		type: "file",
		content: Buffer.from("x"),
	});
	agent.files.set("essay/src/composer.css", {
		type: "file",
		content: Buffer.from("x"),
	});
	return async () => {
		await app.close();
	};
});

test.skipIf(skip)("the owner gets matching paths from the agent", async () => {
	const response = await search(alice, workspaceId, projectId, { query: "COMPOSER" });
	expect(response.statusCode).toBe(200);
	expect(response.json()).toEqual({
		paths: ["src/Composer.tsx", "src/composer.css"],
		truncated: false,
	});
});

test.skipIf(skip)("the limit reaches the agent, and defaults to twenty", async () => {
	const cut = await search(alice, workspaceId, projectId, {
		query: "composer",
		limit: 1,
	});
	expect(cut.json()).toEqual({ paths: ["src/Composer.tsx"], truncated: true });

	for (let i = 0; i < 25; i += 1) {
		agent.files.set(`essay/f${i}.txt`, { type: "file", content: Buffer.from("x") });
	}
	const defaulted = await search(alice, workspaceId, projectId, { query: ".txt" });
	expect(defaulted.json().paths).toHaveLength(20);
	expect(defaulted.json().truncated).toBe(true);
});

test.skipIf(skip)(
	"a request the contract refuses is a 400 and never reaches the agent",
	async () => {
		const before = searchCalls().length;
		for (const body of [
			{},
			{ query: "x".repeat(201) },
			{ query: "x", limit: 0 },
			{ query: "x", limit: MAX_FILE_NAME_MATCHES + 1 },
			{ query: 7 },
		]) {
			const response = await search(alice, workspaceId, projectId, body);
			expect(response.statusCode).toBe(400);
			expect(response.json().code).toBe("VALIDATION_FAILED");
		}
		expect(searchCalls().length).toBe(before);
	},
);

test.skipIf(skip)("the query travels in the body, never in the URL", async () => {
	await search(alice, workspaceId, projectId, { query: "secret-plan" });
	const call = searchCalls().at(-1);
	expect(call).toEqual({ method: "POST", url: "/projects/essay/file-search" });
});

test.skipIf(skip)(
	"another student gets a 404 and the agent is never called",
	async () => {
		const bob = new CookieJar();
		await loginAs(app, "bob", bob);
		const before = searchCalls().length;
		const response = await search(bob, workspaceId, projectId, { query: "composer" });
		expect(response.statusCode).toBe(404);
		expect(response.json().code).toBe("WORKSPACE_NOT_FOUND");
		expect(searchCalls().length).toBe(before);
	},
);

test.skipIf(skip)("someone not signed in is refused", async () => {
	const before = searchCalls().length;
	const response = await search(new CookieJar(), workspaceId, projectId, {
		query: "x",
	});
	expect(response.statusCode).toBe(401);
	expect(searchCalls()).toHaveLength(before);
});

test.skipIf(skip)("a project that is not in this workspace is a 404", async () => {
	const response = await search(alice, workspaceId, crypto.randomUUID(), {
		query: "composer",
	});
	expect(response.statusCode).toBe(404);
});

test.skipIf(skip)("a stopped workspace answers 409", async () => {
	await testDb.db
		.updateTable("workspaces")
		.set({ state: "stopped", updated_at: new Date().toISOString() })
		.where("id", "=", workspaceId)
		.execute();
	const response = await search(alice, workspaceId, projectId, { query: "composer" });
	expect(response.statusCode).toBe(409);
	expect(response.json().code).toBe("AGENT_UNAVAILABLE");
});

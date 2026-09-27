import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/** The student's reinstall note, passed through to the agent (SPEC.md §22.3, ADR 0042). */

const skip = !hasTestDb();
const AGENT_TOKEN = "reinstall-note-token";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let bob: CookieJar;
let carol: CookieJar;
let workspaceId: string;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ redirectUris: [`${PUBLIC_URL}/auth/callback`] });
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
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
	bob = new CookieJar();
	await loginAs(app, "bob", bob);
	carol = new CookieJar();
	await loginAs(app, "carol", carol);
	workspaceId = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(alice, PUBLIC_URL),
		})
	).json().id;
	return async () => {
		await app.close();
	};
});

async function markRunning(): Promise<void> {
	await testDb.db
		.updateTable("workspaces")
		.set({
			state: "running",
			agent_address: "127.0.0.1",
			agent_token: `${AGENT_TOKEN}:${workspaceId}`,
		})
		.where("id", "=", workspaceId)
		.execute();
}

async function seed(packages: string[]): Promise<void> {
	await fetch(`http://127.0.0.1:${agent.port}/__test/reinstall-note`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, packages }),
	});
}

function getNote(jar: CookieJar) {
	return app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/reinstall-note`,
		headers: { cookie: jar.cookieHeader() },
	});
}

test.skipIf(skip)("the owner gets the agent's note", async () => {
	await markRunning();
	await seed(["python3-venv", "htop"]);
	const response = await getNote(alice);
	expect(response.statusCode).toBe(200);
	expect(response.json()).toEqual({ packages: ["python3-venv", "htop"] });
});

test.skipIf(skip)("another student and an administrator get 404", async () => {
	await markRunning();
	await seed(["htop"]);
	expect((await getNote(bob)).statusCode).toBe(404);
	expect((await getNote(carol)).statusCode).toBe(404);
});

test.skipIf(skip)("a stopped workspace has no agent to ask", async () => {
	const response = await getNote(alice);
	expect(response.statusCode).toBe(409);
});

test.skipIf(skip)(
	"a name that is not a package name is refused, not shown",
	async () => {
		await markRunning();
		await seed(["htop", "$(id)"]);
		const response = await getNote(alice);
		expect(response.statusCode).toBe(503);
		expect(response.body).not.toContain("$(id)");
	},
);

test.skipIf(skip)("dismiss is passed to the agent", async () => {
	await markRunning();
	await seed(["htop"]);
	const response = await app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/reinstall-note/dismiss`,
		headers: csrfHeaders(alice, PUBLIC_URL),
	});
	expect(response.statusCode).toBe(204);
	expect((await getNote(alice)).json()).toEqual({ packages: [] });
});

test.skipIf(skip)("dismiss by anyone else is a 404 and leaves the note", async () => {
	await markRunning();
	await seed(["htop"]);
	const response = await app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/reinstall-note/dismiss`,
		headers: csrfHeaders(carol, PUBLIC_URL),
	});
	expect(response.statusCode).toBe(404);
	expect((await getNote(alice)).json()).toEqual({ packages: ["htop"] });
});

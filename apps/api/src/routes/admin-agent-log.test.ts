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
import {
	FAKE_AGENT_LOG,
	type FakeAgent,
	startFakeAgent,
} from "../testing/fake-agent/index.js";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

/** `GET /admin/workspaces/:id/agent-log` (SPEC.md 20.1, ADR 0060). */

const skip = !hasTestDb();
const AGENT_TOKEN = "agent-log-token";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let carol: CookieJar;
let workspaceId: string;

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
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
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

function readLog(jar: CookieJar, id = workspaceId) {
	return app.inject({
		method: "GET",
		url: `/admin/workspaces/${id}/agent-log`,
		headers: { cookie: jar.cookieHeader() },
	});
}

test.skipIf(skip)("an administrator reads a running agent's log", async () => {
	await markRunning();
	const res = await readLog(carol);
	expect(res.statusCode).toBe(200);
	expect(res.json()).toEqual({ lines: FAKE_AGENT_LOG });
});

test.skipIf(skip)("a workspace that is not running is 409", async () => {
	const res = await readLog(carol);
	expect(res.statusCode).toBe(409);
	expect(res.json().code).toBe("WORKSPACE_NOT_RUNNING");
});

test.skipIf(skip)("a student, even the owner, is 403", async () => {
	await markRunning();
	const res = await readLog(alice);
	expect(res.statusCode).toBe(403);
});

test.skipIf(skip)("an unknown workspace is 404", async () => {
	const res = await readLog(carol, "00000000-0000-4000-8000-000000000000");
	expect(res.statusCode).toBe(404);
});

test.skipIf(skip)("an unreachable agent is 503", async () => {
	await markRunning();
	await testDb.db
		.updateTable("workspaces")
		.set({ agent_token: "wrong-token" })
		.where("id", "=", workspaceId)
		.execute();
	const res = await readLog(carol);
	expect(res.statusCode).toBe(503);
});

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
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

const skip = !hasTestDb();
let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({});
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	app = buildTestServer(testDb.db, mock.issuer);
	await app.ready();
	return async () => {
		await app.close();
	};
});

test.skipIf(skip)("GET /admin/workspaces without a session is 401", async () => {
	const res = await app.inject({ method: "GET", url: "/admin/workspaces" });
	expect(res.statusCode).toBe(401);
});

test.skipIf(skip)("a student is refused with 403", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	const res = await app.inject({
		method: "GET",
		url: "/admin/workspaces",
		headers: { cookie: jar.cookieHeader() },
	});
	expect(res.statusCode).toBe(403);
	expect(res.json().code).toBe("FORBIDDEN");
});

test.skipIf(skip)("an administrator lists every workspace", async () => {
	const alice = new CookieJar();
	await loginAs(app, "alice", alice);
	const aliceWorkspace = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(alice, PUBLIC_URL),
		})
	).json();

	const bob = new CookieJar();
	await loginAs(app, "bob", bob);
	await app.inject({
		method: "POST",
		url: "/workspaces",
		headers: csrfHeaders(bob, PUBLIC_URL),
	});

	const carol = new CookieJar();
	await loginAs(app, "carol", carol);
	const res = await app.inject({
		method: "GET",
		url: "/admin/workspaces",
		headers: { cookie: carol.cookieHeader() },
	});

	expect(res.statusCode).toBe(200);
	const body = res.json();
	expect(body.workspaces).toHaveLength(2);
	expect(body.workspaces[0].id).toBe(aliceWorkspace.id);
	expect(body.workspaces[0].activeConnections).toBe(0);
});

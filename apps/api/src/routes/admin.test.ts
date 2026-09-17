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
	mock = await startMockOidcProvider({
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
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

// --- Platform settings and per-user overrides (SPEC.md §6.4) ---

/** Seed the single settings row the worker normally writes at startup. */
async function seedSettings(seconds = 600): Promise<void> {
	await testDb.db
		.insertInto("settings")
		.values({ id: 1, shutdown_grace_seconds: seconds })
		.execute();
}

async function adminJar(): Promise<CookieJar> {
	const jar = new CookieJar();
	await loginAs(app, "carol", jar);
	return jar;
}

async function studentJar(): Promise<CookieJar> {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);
	return jar;
}

test.skipIf(skip)("a student is refused on every settings route", async () => {
	await seedSettings();
	const jar = await studentJar();
	const cookie = { cookie: jar.cookieHeader() };
	const write = csrfHeaders(jar, PUBLIC_URL);

	const calls = [
		await app.inject({ method: "GET", url: "/admin/settings", headers: cookie }),
		await app.inject({
			method: "PUT",
			url: "/admin/settings",
			headers: write,
			payload: { shutdownGraceSeconds: 60 },
		}),
		await app.inject({ method: "GET", url: "/admin/users", headers: cookie }),
		await app.inject({
			method: "PUT",
			url: `/admin/users/${crypto.randomUUID()}/settings`,
			headers: write,
			payload: { shutdownGraceSeconds: 60 },
		}),
	];

	for (const res of calls) {
		expect(res.statusCode).toBe(403);
		expect(res.json().code).toBe("FORBIDDEN");
	}
});

test.skipIf(skip)("GET /admin/settings is 404 before the worker seeds", async () => {
	const jar = await adminJar();
	const res = await app.inject({
		method: "GET",
		url: "/admin/settings",
		headers: { cookie: jar.cookieHeader() },
	});
	expect(res.statusCode).toBe(404);
	expect(res.json().code).toBe("NOT_FOUND");
});

test.skipIf(skip)("an administrator reads and changes the grace period", async () => {
	await seedSettings(600);
	const jar = await adminJar();

	const before = await app.inject({
		method: "GET",
		url: "/admin/settings",
		headers: { cookie: jar.cookieHeader() },
	});
	expect(before.statusCode).toBe(200);
	expect(before.json().shutdownGraceSeconds).toBe(600);

	const put = await app.inject({
		method: "PUT",
		url: "/admin/settings",
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: { shutdownGraceSeconds: 0 },
	});
	expect(put.statusCode).toBe(200);
	expect(put.json().shutdownGraceSeconds).toBe(0);
	expect(put.json().updatedAt).not.toBeNull();

	const after = await app.inject({
		method: "GET",
		url: "/admin/settings",
		headers: { cookie: jar.cookieHeader() },
	});
	expect(after.json().shutdownGraceSeconds).toBe(0);

	const audits = await testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "settings.shutdown_grace_updated")
		.execute();
	expect(audits).toHaveLength(1);
	expect(audits[0]?.target).toBe("settings");
	expect(audits[0]?.metadata).toMatchObject({ from: 600, to: 0 });
});

test.skipIf(skip)("PUT /admin/settings rejects bad bodies", async () => {
	await seedSettings();
	const jar = await adminJar();

	for (const payload of [
		{ shutdownGraceSeconds: -1 },
		{ shutdownGraceSeconds: 1.5 },
		{ shutdownGraceSeconds: "600" },
		{ shutdownGraceSeconds: 600, extra: true },
		{},
	]) {
		const res = await app.inject({
			method: "PUT",
			url: "/admin/settings",
			headers: csrfHeaders(jar, PUBLIC_URL),
			payload,
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("VALIDATION_FAILED");
	}
});

test.skipIf(skip)("an administrator lists users and sets an override", async () => {
	const student = new CookieJar();
	await loginAs(app, "alice", student);
	const jar = await adminJar();

	const list = await app.inject({
		method: "GET",
		url: "/admin/users",
		headers: { cookie: jar.cookieHeader() },
	});
	expect(list.statusCode).toBe(200);
	const users = list.json().users as Array<Record<string, unknown>>;
	expect(users.length).toBe(2);
	const alice = users.find((u) => u.displayName === "Alice Student");
	expect(alice?.shutdownGraceSeconds).toBeNull();

	const put = await app.inject({
		method: "PUT",
		url: `/admin/users/${alice?.id}/settings`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: { shutdownGraceSeconds: 0 },
	});
	expect(put.statusCode).toBe(200);
	expect(put.json().shutdownGraceSeconds).toBe(0);

	const cleared = await app.inject({
		method: "PUT",
		url: `/admin/users/${alice?.id}/settings`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: { shutdownGraceSeconds: null },
	});
	expect(cleared.json().shutdownGraceSeconds).toBeNull();

	const audits = await testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "user.shutdown_grace_updated")
		.execute();
	expect(audits).toHaveLength(2);
	expect(audits[0]?.target).toBe(alice?.id);
	expect(audits[0]?.metadata).toMatchObject({ from: null, to: 0 });
	expect(audits[1]?.metadata).toMatchObject({ from: 0, to: null });
});

test.skipIf(skip)("an unknown user id is 404 and a bad body is 400", async () => {
	const jar = await adminJar();

	const missing = await app.inject({
		method: "PUT",
		url: `/admin/users/${crypto.randomUUID()}/settings`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: { shutdownGraceSeconds: 60 },
	});
	expect(missing.statusCode).toBe(404);
	expect(missing.json().code).toBe("NOT_FOUND");

	const badId = await app.inject({
		method: "PUT",
		url: "/admin/users/not-a-uuid/settings",
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: { shutdownGraceSeconds: 60 },
	});
	expect(badId.statusCode).toBe(400);

	const badBody = await app.inject({
		method: "PUT",
		url: `/admin/users/${crypto.randomUUID()}/settings`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: { shutdownGraceSeconds: -1 },
	});
	expect(badBody.statusCode).toBe(400);
	expect(badBody.json().code).toBe("VALIDATION_FAILED");
});

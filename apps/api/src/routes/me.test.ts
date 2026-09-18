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

async function put(jar: CookieJar, body: Record<string, unknown>) {
	return await app.inject({
		method: "PUT",
		url: "/me/settings",
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: body,
	});
}

test.skipIf(skip)("GET /me/settings without a session is 401", async () => {
	const res = await app.inject({ method: "GET", url: "/me/settings" });
	expect(res.statusCode).toBe(401);
});

test.skipIf(skip)("a new user gets the defaults", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	const res = await app.inject({
		method: "GET",
		url: "/me/settings",
		headers: { cookie: jar.cookieHeader() },
	});
	expect(res.statusCode).toBe(200);
	expect(res.json()).toEqual({
		autoSave: true,
		autoSaveDelaySeconds: 5,
		wordWrap: false,
	});
});

test.skipIf(skip)("a change is merged and the rest keeps its value", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	const first = await put(jar, { wordWrap: true });
	expect(first.statusCode).toBe(200);
	expect(first.json()).toEqual({
		autoSave: true,
		autoSaveDelaySeconds: 5,
		wordWrap: true,
	});

	const second = await put(jar, { autoSaveDelaySeconds: 30 });
	expect(second.json()).toEqual({
		autoSave: true,
		autoSaveDelaySeconds: 30,
		wordWrap: true,
	});

	const read = await app.inject({
		method: "GET",
		url: "/me/settings",
		headers: { cookie: jar.cookieHeader() },
	});
	expect(read.json()).toEqual({
		autoSave: true,
		autoSaveDelaySeconds: 30,
		wordWrap: true,
	});
});

test.skipIf(skip)("bad values and unknown keys are refused", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	for (const body of [
		{ autoSaveDelaySeconds: 0 },
		{ autoSaveDelaySeconds: 61 },
		{ autoSave: "yes" },
		{ theme: "dark" },
		{},
	]) {
		const res = await put(jar, body);
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("VALIDATION_FAILED");
	}
});

test.skipIf(skip)("one user's settings never reach another user", async () => {
	const alice = new CookieJar();
	await loginAs(app, "alice", alice);
	const bob = new CookieJar();
	await loginAs(app, "bob", bob);

	await put(alice, { wordWrap: true, autoSaveDelaySeconds: 42 });

	const bobRead = await app.inject({
		method: "GET",
		url: "/me/settings",
		headers: { cookie: bob.cookieHeader() },
	});
	expect(bobRead.json()).toEqual({
		autoSave: true,
		autoSaveDelaySeconds: 5,
		wordWrap: false,
	});

	// Bob's own change must not touch Alice's row.
	await put(bob, { autoSave: false });
	const aliceRead = await app.inject({
		method: "GET",
		url: "/me/settings",
		headers: { cookie: alice.cookieHeader() },
	});
	expect(aliceRead.json()).toEqual({
		autoSave: true,
		autoSaveDelaySeconds: 42,
		wordWrap: true,
	});
});

test.skipIf(skip)(
	"an unknown key in the stored row does not lose the known ones",
	async () => {
		const jar = new CookieJar();
		await loginAs(app, "alice", jar);

		await testDb.db
			.updateTable("users")
			.set({
				editor_settings: JSON.stringify({
					autoSave: false,
					autoSaveDelaySeconds: 20,
					wordWrap: true,
					theme: "dark",
				}),
			})
			.execute();

		const read = await app.inject({
			method: "GET",
			url: "/me/settings",
			headers: { cookie: jar.cookieHeader() },
		});
		expect(read.json()).toEqual({
			autoSave: false,
			autoSaveDelaySeconds: 20,
			wordWrap: true,
		});

		// A later change must not write the defaults over the other stored values.
		const res = await put(jar, { wordWrap: false });
		expect(res.json()).toEqual({
			autoSave: false,
			autoSaveDelaySeconds: 20,
			wordWrap: false,
		});
	},
);

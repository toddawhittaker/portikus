import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { systemTimezones, UpdateEditorSettingsRequest } from "@portikus/contracts";
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
		wordWrap: true,
		terminalTheme: "dark",
		timezone: "America/New_York",
		timezones: [...systemTimezones()],
	});
});

test.skipIf(skip)("a change is merged and the rest keeps its value", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	const first = await put(jar, { wordWrap: false });
	expect(first.statusCode).toBe(200);
	expect(first.json()).toEqual({
		autoSave: true,
		autoSaveDelaySeconds: 5,
		wordWrap: false,
		terminalTheme: "dark",
		timezone: "America/New_York",
		timezones: [...systemTimezones()],
	});

	const second = await put(jar, { autoSaveDelaySeconds: 30 });
	expect(second.json()).toEqual({
		autoSave: true,
		autoSaveDelaySeconds: 30,
		wordWrap: false,
		terminalTheme: "dark",
		timezone: "America/New_York",
		timezones: [...systemTimezones()],
	});

	const read = await app.inject({
		method: "GET",
		url: "/me/settings",
		headers: { cookie: jar.cookieHeader() },
	});
	expect(read.json()).toEqual({
		autoSave: true,
		autoSaveDelaySeconds: 30,
		wordWrap: false,
		terminalTheme: "dark",
		timezone: "America/New_York",
		timezones: [...systemTimezones()],
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
		// Issue #287: only a name on the zone list is taken.
		{ timezone: "Mars/Olympus" },
		{ timezone: "America/New_York; id" },
		{ timezone: "" },
	]) {
		const res = await put(jar, body);
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("VALIDATION_FAILED");
	}
});

/** Issue #287: a zone the student chooses is stored and read back. */
test.skipIf(skip)("a known zone is accepted and kept", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	const res = await put(jar, { timezone: "Europe/Berlin" });
	expect(res.statusCode).toBe(200);
	expect(res.json().timezone).toBe("Europe/Berlin");

	const read = await app.inject({
		method: "GET",
		url: "/me/settings",
		headers: { cookie: jar.cookieHeader() },
	});
	expect(read.json().timezone).toBe("Europe/Berlin");
});

/**
 * Issue #287: the dialog builds its zone select from the list GET hands it,
 * so every name on that list has to be one PUT accepts. The browser's own
 * zone list is not consulted anywhere.
 */
test.skipIf(skip)("the zone list GET hands over is the list PUT accepts", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	const read = await app.inject({
		method: "GET",
		url: "/me/settings",
		headers: { cookie: jar.cookieHeader() },
	});
	const offered: string[] = read.json().timezones;
	expect(offered.length).toBeGreaterThan(100);
	expect(offered).toContain("America/New_York");

	for (const zone of offered) {
		expect(UpdateEditorSettingsRequest.safeParse({ timezone: zone }).success).toBe(
			true,
		);
	}

	// And one of them all the way through the route.
	const last = offered.at(-1);
	if (last === undefined) throw new Error("the zone list was empty");
	expect((await put(jar, { timezone: last })).statusCode).toBe(200);
});

test.skipIf(skip)("one user's settings never reach another user", async () => {
	const alice = new CookieJar();
	await loginAs(app, "alice", alice);
	const bob = new CookieJar();
	await loginAs(app, "bob", bob);

	await put(alice, { wordWrap: false, autoSaveDelaySeconds: 42 });

	const bobRead = await app.inject({
		method: "GET",
		url: "/me/settings",
		headers: { cookie: bob.cookieHeader() },
	});
	expect(bobRead.json()).toEqual({
		autoSave: true,
		autoSaveDelaySeconds: 5,
		wordWrap: true,
		terminalTheme: "dark",
		timezone: "America/New_York",
		timezones: [...systemTimezones()],
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
		wordWrap: false,
		terminalTheme: "dark",
		timezone: "America/New_York",
		timezones: [...systemTimezones()],
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
					terminalTheme: "dark",
					timezone: "America/New_York",
					theme: "dark",
				}),
			})
			.where("oidc_subject", "=", "alice")
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
			terminalTheme: "dark",
			timezone: "America/New_York",
			timezones: [...systemTimezones()],
		});

		// A later change must not write the defaults over the other stored values.
		const res = await put(jar, { wordWrap: false });
		expect(res.json()).toEqual({
			autoSave: false,
			autoSaveDelaySeconds: 20,
			wordWrap: false,
			terminalTheme: "dark",
			timezone: "America/New_York",
			timezones: [...systemTimezones()],
		});
	},
);

/**
 * Issue #287: a zone name this build no longer knows falls back to the
 * default on its own and takes nothing else with it. Parsed as one object,
 * an unknown zone threw away the student's auto-save, word wrap and terminal
 * colours as well.
 */
test.skipIf(skip)("an unknown stored zone loses only the zone", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	await testDb.db
		.updateTable("users")
		.set({
			editor_settings: JSON.stringify({
				autoSave: false,
				autoSaveDelaySeconds: 20,
				wordWrap: false,
				terminalTheme: "light",
				timezone: "Mars/Olympus",
			}),
		})
		.where("oidc_subject", "=", "alice")
		.execute();

	const read = await app.inject({
		method: "GET",
		url: "/me/settings",
		headers: { cookie: jar.cookieHeader() },
	});
	expect(read.json()).toEqual({
		autoSave: false,
		autoSaveDelaySeconds: 20,
		wordWrap: false,
		terminalTheme: "light",
		timezone: "America/New_York",
		timezones: [...systemTimezones()],
	});
});

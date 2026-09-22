import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import {
	MAX_PROFILE_PICTURE_BYTES,
	systemTimezones,
	UpdateEditorSettingsRequest,
} from "@portikus/contracts";
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
		appearance: "system",
		screenReaderMode: false,
		timezones: [...systemTimezones()],
		appearanceStored: false,
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
		appearance: "system",
		screenReaderMode: false,
		timezones: [...systemTimezones()],
		appearanceStored: false,
	});

	const second = await put(jar, { autoSaveDelaySeconds: 30 });
	expect(second.json()).toEqual({
		autoSave: true,
		autoSaveDelaySeconds: 30,
		wordWrap: false,
		terminalTheme: "dark",
		timezone: "America/New_York",
		appearance: "system",
		screenReaderMode: false,
		timezones: [...systemTimezones()],
		appearanceStored: false,
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
		appearance: "system",
		screenReaderMode: false,
		timezones: [...systemTimezones()],
		appearanceStored: false,
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
		appearance: "system",
		screenReaderMode: false,
		timezones: [...systemTimezones()],
		appearanceStored: false,
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
		appearance: "system",
		screenReaderMode: false,
		timezones: [...systemTimezones()],
		appearanceStored: false,
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
			appearance: "system",
			screenReaderMode: false,
			timezones: [...systemTimezones()],
			appearanceStored: false,
		});

		// A later change must not write the defaults over the other stored values.
		const res = await put(jar, { wordWrap: false });
		expect(res.json()).toEqual({
			autoSave: false,
			autoSaveDelaySeconds: 20,
			wordWrap: false,
			terminalTheme: "dark",
			timezone: "America/New_York",
			appearance: "system",
			screenReaderMode: false,
			appearanceStored: false,
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
		appearance: "system",
		screenReaderMode: false,
		timezones: [...systemTimezones()],
		appearanceStored: false,
	});
});

/** Issue #300: appearance is saved per user, merged like any other setting. */
test.skipIf(skip)("appearance is saved and merged with the rest", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	await put(jar, { wordWrap: false });
	const res = await put(jar, { appearance: "dark" });
	expect(res.statusCode).toBe(200);
	expect(res.json()).toMatchObject({ appearance: "dark", wordWrap: false });
	expect((await put(jar, { appearance: "sepia" })).statusCode).toBe(400);

	const other = new CookieJar();
	await loginAs(app, "bob", other);
	const bob = await app.inject({
		method: "GET",
		url: "/me/settings",
		headers: { cookie: other.cookieHeader() },
	});
	expect(bob.json()).toMatchObject({ appearance: "system" });
});

/** Issue #357: screen-reader mode is off by default, saved per user, merged like any other setting. */
test.skipIf(skip)("screen-reader mode is saved per user and merged", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	await put(jar, { wordWrap: false });
	const res = await put(jar, { screenReaderMode: true });
	expect(res.statusCode).toBe(200);
	expect(res.json()).toMatchObject({ screenReaderMode: true, wordWrap: false });

	const other = new CookieJar();
	await loginAs(app, "bob", other);
	const bob = await app.inject({
		method: "GET",
		url: "/me/settings",
		headers: { cookie: other.cookieHeader() },
	});
	expect(bob.json()).toMatchObject({ screenReaderMode: false });
});

const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(32, 1),
]);

function getAs(jar: CookieJar, url: string) {
	return app.inject({ method: "GET", url, headers: { cookie: jar.cookieHeader() } });
}

function putPicture(jar: CookieJar, body: Buffer, type = "image/png") {
	return app.inject({
		method: "PUT",
		url: "/me/picture",
		headers: { ...csrfHeaders(jar, PUBLIC_URL), "content-type": type },
		payload: body,
	});
}

test.skipIf(skip)("the profile routes need a session", async () => {
	expect((await app.inject({ method: "GET", url: "/me/profile" })).statusCode).toBe(
		401,
	);
	expect((await app.inject({ method: "GET", url: "/me/picture" })).statusCode).toBe(
		401,
	);
});

test.skipIf(skip)(
	"a new profile has the sign-in details and nothing else",
	async () => {
		const jar = new CookieJar();
		await loginAs(app, "alice", jar);

		const res = await getAs(jar, "/me/profile");
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({ github: null, website: null, picture: null });
		expect(typeof res.json().displayName).toBe("string");
	},
);

test.skipIf(skip)("links are saved, cleared, and validated", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);
	const putProfile = (payload: Record<string, unknown>) =>
		app.inject({
			method: "PUT",
			url: "/me/profile",
			headers: csrfHeaders(jar, PUBLIC_URL),
			payload,
		});

	const saved = await putProfile({ github: "alice-ex", website: "https://a.example/" });
	expect(saved.statusCode).toBe(200);
	expect(saved.json()).toMatchObject({
		github: "alice-ex",
		website: "https://a.example/",
	});

	for (const body of [
		{ website: "http://a.example/" },
		{ website: "javascript:alert(1)" },
		{ github: "not a name" },
		{ displayName: "Mallory" },
	]) {
		expect((await putProfile(body)).statusCode, JSON.stringify(body)).toBe(400);
	}

	const cleared = await putProfile({ website: null });
	expect(cleared.json()).toMatchObject({ github: "alice-ex", website: null });
});

test.skipIf(skip)("a png picture is stored and served only to its owner", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	const res = await putPicture(jar, PNG);
	expect(res.statusCode).toBe(200);
	const picture = res.json().picture as string;
	expect(picture).toMatch(/^\/me\/picture\?v=\d+$/);

	const served = await getAs(jar, picture);
	expect(served.statusCode).toBe(200);
	expect(served.headers["content-type"]).toBe("image/png");
	expect(served.headers["x-content-type-options"]).toBe("nosniff");
	expect(served.rawPayload.equals(PNG)).toBe(true);

	// /me/picture is always the caller's own; bob has none.
	const other = new CookieJar();
	await loginAs(app, "bob", other);
	expect((await getAs(other, "/me/picture")).statusCode).toBe(404);

	const removed = await app.inject({
		method: "DELETE",
		url: "/me/picture",
		headers: csrfHeaders(jar, PUBLIC_URL),
	});
	expect(removed.json()).toMatchObject({ picture: null });
	expect((await getAs(jar, "/me/picture")).statusCode).toBe(404);
});

/** Security review: only the versioned picture URL may be cached for long. */
test.skipIf(skip)(
	"the picture is cached long only under its versioned URL",
	async () => {
		const jar = new CookieJar();
		await loginAs(app, "alice", jar);
		const picture = (await putPicture(jar, PNG)).json().picture as string;

		const versioned = await getAs(jar, picture);
		expect(versioned.headers["cache-control"]).toBe(
			"private, max-age=31536000, immutable",
		);

		const bare = await getAs(jar, "/me/picture");
		expect(bare.statusCode).toBe(200);
		expect(bare.headers["cache-control"]).toBe("private, no-cache");
	},
);

test.skipIf(skip)("a picture over the cap or of another type is refused", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	const big = Buffer.concat([PNG, Buffer.alloc(MAX_PROFILE_PICTURE_BYTES)]);
	const tooBig = await putPicture(jar, big);
	expect(tooBig.statusCode).toBe(413);
	expect(tooBig.json()).toMatchObject({ code: "FILE_TOO_LARGE" });

	// The type is read from the bytes, not from the header.
	const gif = Buffer.from("GIF89a-not-a-png");
	expect((await putPicture(jar, gif)).statusCode).toBe(415);
	expect((await putPicture(jar, gif, "image/png")).statusCode).toBe(415);

	expect((await getAs(jar, "/me/profile")).json()).toMatchObject({ picture: null });
});

/** Two saves at once, each changing a different setting, both survive. */
test.skipIf(skip)("concurrent saves of different settings both survive", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	const saves = await Promise.all([
		put(jar, { wordWrap: false }),
		put(jar, { appearance: "dark" }),
		put(jar, { autoSaveDelaySeconds: 30 }),
	]);
	for (const res of saves) expect(res.statusCode).toBe(200);

	expect((await getAs(jar, "/me/settings")).json()).toMatchObject({
		wordWrap: false,
		appearance: "dark",
		autoSaveDelaySeconds: 30,
	});
});

/** A defaulted appearance is told apart from a saved one, for the pk-theme upgrade. */
test.skipIf(skip)("GET says whether appearance was saved or defaulted", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);
	const stored = async () => (await getAs(jar, "/me/settings")).json().appearanceStored;

	expect(await stored()).toBe(false);
	await put(jar, { wordWrap: false });
	expect(await stored()).toBe(false);
	const saved = await put(jar, { appearance: "system" });
	expect(saved.json().appearanceStored).toBe(true);
	expect(await stored()).toBe(true);
});

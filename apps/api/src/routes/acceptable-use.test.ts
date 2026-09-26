import { randomBytes } from "node:crypto";
import { createSession, dexLocalSubject } from "@portikus/auth";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { DEFAULT_ACCEPTABLE_USE_TEXT } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiUser,
	type TestDb,
} from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/**
 * The acceptable-use gate (docs/EPIC-14-3.md rulings 29 to 33): the second
 * gate on the session check, after the password gate.
 */

const skip = !hasTestDb();

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ redirectUris: [`${PUBLIC_URL}/auth/callback`] });
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	await testDb.db
		.insertInto("settings")
		.values({ id: 1, shutdown_grace_seconds: 900 })
		.execute();
	app = buildTestServer(testDb.db, mock.issuer);
	await app.ready();
	return async () => {
		await app.close();
	};
});

/** Sign a mock user in as someone who has never accepted. Returns the user's id. */
async function unaccepted(sub: string, jar: CookieJar): Promise<string> {
	await loginAs(app, sub, jar);
	const row = await testDb.db
		.updateTable("users")
		.set({ acceptable_use_version: null, acceptable_use_accepted_at: null })
		.where("oidc_subject", "=", sub)
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

function get(jar: CookieJar, url: string) {
	return app.inject({ method: "GET", url, headers: { cookie: jar.cookieHeader() } });
}

function accept(
	jar: CookieJar,
	version: unknown,
	headers = csrfHeaders(jar, PUBLIC_URL),
) {
	return app.inject({
		method: "POST",
		url: "/me/acceptable-use",
		headers,
		payload: { version },
	});
}

/** A sample of routes from the API's router files, for the refusal checks. */
const SAMPLE = [
	["GET", `/workspaces/${crypto.randomUUID()}`],
	["POST", "/workspaces"],
	["GET", "/me/settings"],
	["GET", "/me/notifications"],
	["GET", "/admin/users"],
	["GET", "/courses"],
] as const;

async function expectGated(jar: CookieJar, code: string): Promise<void> {
	for (const [method, url] of SAMPLE) {
		const res = await app.inject({
			method,
			url,
			headers: csrfHeaders(jar, PUBLIC_URL),
		});
		expect(res.statusCode, `${method} ${url}`).toBe(403);
		expect(res.json().code, `${method} ${url}`).toBe(code);
	}
}

describe.skipIf(skip)("the acceptable-use gate", () => {
	test("a new account has not accepted: /auth/me says so and other routes answer 403", async () => {
		const jar = new CookieJar();
		await unaccepted("alice", jar);
		const me = await get(jar, "/auth/me");
		expect(me.statusCode).toBe(200);
		expect(me.json()).toMatchObject({ mustChangePassword: false, mustAcceptUse: true });
		await expectGated(jar, "ACCEPTABLE_USE_REQUIRED");
	});

	test("the statement and sign-out stay reachable", async () => {
		const jar = new CookieJar();
		await unaccepted("alice", jar);
		const statement = await get(jar, "/me/acceptable-use");
		expect(statement.statusCode).toBe(200);
		expect(statement.json()).toEqual({ text: DEFAULT_ACCEPTABLE_USE_TEXT, version: 1 });
		const out = await app.inject({
			method: "POST",
			url: "/auth/logout",
			headers: csrfHeaders(jar, PUBLIC_URL),
		});
		expect(out.statusCode).toBeLessThan(400);
	});

	test("refuses a WebSocket upgrade", async () => {
		const jar = new CookieJar();
		await unaccepted("alice", jar);
		const res = await app.inject({
			method: "GET",
			url: `/workspaces/${crypto.randomUUID()}/ws`,
			headers: {
				cookie: jar.cookieHeader(),
				origin: new URL(PUBLIC_URL).origin,
				upgrade: "websocket",
				connection: "upgrade",
				"sec-websocket-version": "13",
				"sec-websocket-key": randomBytes(16).toString("base64"),
			},
		});
		expect(res.statusCode).toBe(403);
		expect(res.json().code).toBe("ACCEPTABLE_USE_REQUIRED");
	});

	test("accepting the current version clears the gate and is audited with the version only", async () => {
		const jar = new CookieJar();
		const id = await unaccepted("alice", jar);
		const res = await accept(jar, 1);
		expect(res.statusCode).toBe(204);

		expect((await get(jar, "/auth/me")).json()).toMatchObject({ mustAcceptUse: false });
		expect((await get(jar, "/me/settings")).statusCode).toBe(200);
		const user = await testDb.db
			.selectFrom("users")
			.select(["acceptable_use_version", "acceptable_use_accepted_at"])
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
		expect(user.acceptable_use_version).toBe(1);
		expect(user.acceptable_use_accepted_at).toBeInstanceOf(Date);
		const rows = await testDb.db
			.selectFrom("audit_events")
			.select(["actor", "target", "result", "metadata"])
			.where("action", "=", "user.acceptable_use_accepted")
			.execute();
		expect(rows).toEqual([
			{ actor: `user:${id}`, target: id, result: "ok", metadata: { version: 1 } },
		]);
	});

	test("an old version answers 409 ACCEPTABLE_USE_CHANGED and changes nothing", async () => {
		await testDb.db
			.updateTable("settings")
			.set({ acceptable_use_version: 3 })
			.execute();
		const jar = new CookieJar();
		await unaccepted("alice", jar);
		const res = await accept(jar, 2);
		expect(res.statusCode).toBe(409);
		expect(res.json().code).toBe("ACCEPTABLE_USE_CHANGED");
		expect((await get(jar, "/auth/me")).json()).toMatchObject({ mustAcceptUse: true });
		const rows = await testDb.db
			.selectFrom("audit_events")
			.select("id")
			.where("action", "=", "user.acceptable_use_accepted")
			.execute();
		expect(rows).toEqual([]);
	});

	test("a malformed version is refused with 400", async () => {
		const jar = new CookieJar();
		await unaccepted("alice", jar);
		expect((await accept(jar, "1")).statusCode).toBe(400);
		expect((await accept(jar, 0)).statusCode).toBe(400);
	});

	test("accepting is CSRF-checked", async () => {
		const jar = new CookieJar();
		await unaccepted("alice", jar);
		const res = await accept(jar, 1, {
			cookie: jar.cookieHeader(),
			origin: "https://evil.example",
		});
		expect(res.statusCode).toBe(403);
		expect((await get(jar, "/auth/me")).json()).toMatchObject({ mustAcceptUse: true });
	});

	test("an account behind both gates meets the password gate first", async () => {
		const jar = new CookieJar();
		const id = await unaccepted("carol", jar);
		await testDb.db
			.updateTable("users")
			.set({ must_change_password: true })
			.where("id", "=", id)
			.execute();
		expect((await get(jar, "/auth/me")).json()).toMatchObject({
			mustChangePassword: true,
			mustAcceptUse: true,
		});
		await expectGated(jar, "PASSWORD_CHANGE_REQUIRED");
		// The second gate's routes wait until the first is passed.
		const statement = await get(jar, "/me/acceptable-use");
		expect(statement.statusCode).toBe(403);
		expect(statement.json().code).toBe("PASSWORD_CHANGE_REQUIRED");
		expect((await accept(jar, 1)).statusCode).toBe(403);

		await testDb.db
			.updateTable("users")
			.set({ must_change_password: false })
			.where("id", "=", id)
			.execute();
		await expectGated(jar, "ACCEPTABLE_USE_REQUIRED");
	});

	test("a changed text puts everyone back behind the gate at their next request", async () => {
		const student = new CookieJar();
		await loginAs(app, "alice", student);
		const admin = new CookieJar();
		await loginAs(app, "carol", admin);
		expect((await get(student, "/me/settings")).statusCode).toBe(200);

		const saved = await app.inject({
			method: "PUT",
			url: "/admin/settings",
			headers: csrfHeaders(admin, PUBLIC_URL),
			payload: { acceptableUseText: "Only coursework here." },
		});
		expect(saved.statusCode).toBe(200);

		await expectGated(student, "ACCEPTABLE_USE_REQUIRED");
		// The administrator who saved it accepts too (ruling 31).
		await expectGated(admin, "ACCEPTABLE_USE_REQUIRED");
		const statement = await get(student, "/me/acceptable-use");
		expect(statement.json()).toEqual({ text: "Only coursework here.", version: 2 });
		expect((await accept(student, 1)).statusCode).toBe(409);
		expect((await accept(student, 2)).statusCode).toBe(204);
		expect((await get(student, "/me/settings")).statusCode).toBe(200);
	});

	test("a Dex local account meets the gate like any other", async () => {
		const jar = new CookieJar();
		const id = await unaccepted("alice", jar);
		await testDb.db
			.updateTable("users")
			.set({ oidc_subject: dexLocalSubject(crypto.randomUUID()) })
			.where("id", "=", id)
			.execute();
		await expectGated(jar, "ACCEPTABLE_USE_REQUIRED");
		expect((await accept(jar, 1)).statusCode).toBe(204);
		expect((await get(jar, "/me/settings")).statusCode).toBe(200);
	});

	test("an account from a course launch meets the gate like any other", async () => {
		const id = await insertTestLtiUser(testDb.db);
		await testDb.db
			.updateTable("users")
			.set({ acceptable_use_version: null })
			.where("id", "=", id)
			.execute();
		const { token } = await createSession(testDb.db, id, 3600, {
			method: "lti",
			courseUserId: null,
		});
		const jar = new CookieJar();
		jar.capture(`portikus_session=${token}`);
		expect((await get(jar, "/auth/me")).json()).toMatchObject({ mustAcceptUse: true });
		await expectGated(jar, "ACCEPTABLE_USE_REQUIRED");
		expect((await accept(jar, 1)).statusCode).toBe(204);
		expect((await get(jar, "/me/settings")).statusCode).toBe(200);
	});
});

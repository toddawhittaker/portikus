import { createOidcClient } from "@portikus/auth";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { silentLogger } from "@portikus/observability";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { toAuthOptions } from "../auth-options.js";
import { buildServer } from "../server.js";
import { buildTestServer, PUBLIC_URL, testConfig } from "../test-support.js";

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

test.skipIf(skip)("GET /auth/me without a session is 401", async () => {
	const res = await app.inject({ method: "GET", url: "/auth/me" });
	expect(res.statusCode).toBe(401);
	expect(res.json().code).toBe("UNAUTHORIZED");
});

test.skipIf(skip)("a student can sign in and see themselves", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	const me = await app.inject({
		method: "GET",
		url: "/auth/me",
		headers: { cookie: jar.cookieHeader() },
	});
	expect(me.statusCode).toBe(200);
	expect(me.json().role).toBe("student");
	expect(me.json().displayName).toBeTruthy();
	expect(me.json().oidcSubject).toBe("alice");
});

test.skipIf(skip)("the admin group maps to the administrator role", async () => {
	const jar = new CookieJar();
	await loginAs(app, "carol", jar);

	const me = await app.inject({
		method: "GET",
		url: "/auth/me",
		headers: { cookie: jar.cookieHeader() },
	});
	expect(me.json().role).toBe("administrator");
});

test.skipIf(skip)("a user in neither group is refused with 403", async () => {
	const jar = new CookieJar();
	const result = await loginAs(app, "dave", jar);
	expect(result.status).toBe(403);
	expect(jar.get("portikus_session")).toBeUndefined();

	const users = await testDb.db.selectFrom("users").selectAll().execute();
	expect(users).toHaveLength(0);

	const denied = await testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "auth.login")
		.where("result", "=", "denied")
		.execute();
	expect(denied).toHaveLength(1);
});

test.skipIf(skip)(
	"a role change at sign-in is audited as user.role_changed",
	async () => {
		const alice = mock.users.alice;
		if (!alice) throw new Error("mock user alice is missing");
		const groups = alice.groups;
		await loginAs(app, "alice", new CookieJar());
		try {
			alice.groups = ["portikus-administrators"];
			const jar = new CookieJar();
			await loginAs(app, "alice", jar);
			// Signing in again with the same groups changes nothing.
			await loginAs(app, "alice", new CookieJar());
		} finally {
			alice.groups = groups;
		}

		const rows = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "user.role_changed")
			.execute();
		expect(rows).toHaveLength(1);
		const user = await testDb.db
			.selectFrom("users")
			.select("id")
			.where("oidc_subject", "=", "alice")
			.executeTakeFirstOrThrow();
		expect(rows[0]?.target).toBe(user.id);
		expect(rows[0]?.actor).toBe("identity-provider");
		expect(rows[0]?.metadata).toEqual({ from: "student", to: "administrator" });
		// Nothing secret leaves (STACK.md §15): only these keys, all short values.
		expect(Object.keys(rows[0]?.metadata ?? {}).sort()).toEqual(["from", "to"]);
	},
);

test.skipIf(skip)("a first sign-in is not a role change", async () => {
	await loginAs(app, "alice", new CookieJar());
	const rows = await testDb.db
		.selectFrom("audit_events")
		.select("id")
		.where("action", "=", "user.role_changed")
		.execute();
	expect(rows).toHaveLength(0);
});

test.skipIf(skip)("a successful login writes an ok audit event", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	const rows = await testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "auth.login")
		.execute();
	expect(rows).toHaveLength(1);
	expect(rows[0]?.result).toBe("ok");
	expect(rows[0]?.actor).toMatch(/^user:/);
});

test.skipIf(skip)("the session cookie is HttpOnly, Lax, and path-scoped", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);
	expect(jar.get("portikus_session")).toBeTruthy();

	// The logout response carries the same cookie options as login.
	const out = await app.inject({
		method: "POST",
		url: "/auth/logout",
		headers: csrfHeaders(jar, PUBLIC_URL),
	});
	const raw = String(out.headers["set-cookie"]);
	expect(raw).toMatch(/portikus_session=/);
	expect(raw).toMatch(/HttpOnly/i);
	expect(raw).toMatch(/SameSite=Lax/i);
	expect(raw).toMatch(/Path=\//);
	// PUBLIC_URL is http in tests, so the cookie must not be marked Secure.
	expect(raw).not.toMatch(/Secure/i);
});

test.skipIf(skip)(
	"logout deletes the session and the next request is 401",
	async () => {
		const jar = new CookieJar();
		await loginAs(app, "alice", jar);

		const out = await app.inject({
			method: "POST",
			url: "/auth/logout",
			headers: csrfHeaders(jar, PUBLIC_URL),
		});
		expect(out.statusCode).toBe(303);

		const sessions = await testDb.db.selectFrom("sessions").selectAll().execute();
		expect(sessions).toHaveLength(0);

		const me = await app.inject({
			method: "GET",
			url: "/auth/me",
			headers: { cookie: jar.cookieHeader() },
		});
		expect(me.statusCode).toBe(401);
	},
);

test.skipIf(skip)("deleting the session row revokes access at once", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	await testDb.db.deleteFrom("sessions").execute();

	const me = await app.inject({
		method: "GET",
		url: "/auth/me",
		headers: { cookie: jar.cookieHeader() },
	});
	expect(me.statusCode).toBe(401);
});

test.skipIf(skip)("disabling the user revokes access at once", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	await testDb.db
		.updateTable("users")
		.set({ disabled_at: new Date().toISOString() })
		.execute();

	const me = await app.inject({
		method: "GET",
		url: "/auth/me",
		headers: { cookie: jar.cookieHeader() },
	});
	expect(me.statusCode).toBe(401);
});

test.skipIf(skip)("the callback without a login cookie is 400", async () => {
	const res = await app.inject({
		method: "GET",
		url: "/auth/callback?code=abc&state=def",
	});
	expect(res.statusCode).toBe(400);
});

test.skipIf(skip)("GET /auth/login redirects to the provider", async () => {
	const res = await app.inject({ method: "GET", url: "/auth/login" });
	expect(res.statusCode).toBe(302);
	expect(res.headers.location).toContain(mock.issuer);
	expect(res.headers["set-cookie"]).toBeTruthy();
});

test.skipIf(skip)("an unsafe request from another origin is refused", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	const res = await app.inject({
		method: "POST",
		url: "/workspaces",
		headers: {
			cookie: jar.cookieHeader(),
			origin: "https://evil.example.com",
			"sec-fetch-site": "cross-site",
		},
	});
	expect(res.statusCode).toBe(403);
});

test.skipIf(skip)("logout accepts the browser's urlencoded form post", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	const out = await app.inject({
		method: "POST",
		url: "/auth/logout",
		headers: {
			...csrfHeaders(jar, PUBLIC_URL),
			"content-type": "application/x-www-form-urlencoded",
		},
		payload: "",
	});
	expect(out.statusCode).toBe(303);
	expect(String(out.headers["set-cookie"])).toMatch(/portikus_session=;/);

	const sessions = await testDb.db.selectFrom("sessions").selectAll().execute();
	expect(sessions).toHaveLength(0);
});

test.skipIf(skip)("an https public URL uses the __Host- cookie prefix", async () => {
	const config = {
		...testConfig(mock.issuer),
		PUBLIC_URL: "https://portikus.example.edu",
	};
	const secure = buildServer({
		db: testDb.db,
		config,
		logger: silentLogger(),
		oidc: createOidcClient(toAuthOptions(config)),
	});
	try {
		const res = await secure.inject({ method: "GET", url: "/auth/login" });
		const raw = String(res.headers["set-cookie"]);
		expect(raw).toMatch(/^__Host-portikus_login=/);
		expect(raw).toMatch(/Secure/i);
		expect(raw).toMatch(/Path=\//);
		expect(raw).not.toMatch(/Domain=/i);
	} finally {
		await secure.close();
	}
});

test.skipIf(skip)(
	"a denied login records a prefixed actor and the client details",
	async () => {
		const jar = new CookieJar();
		await loginAs(app, "dave", jar);

		const row = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "auth.login")
			.where("result", "=", "denied")
			.executeTakeFirstOrThrow();
		expect(row.actor).toBe("subject:dave");
		expect((row.metadata as Record<string, unknown>).ip).toBeTruthy();
	},
);

test.skipIf(skip)("logout writes an auth.logout audit row", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);
	await app.inject({
		method: "POST",
		url: "/auth/logout",
		headers: csrfHeaders(jar, PUBLIC_URL),
	});

	const row = await testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "auth.logout")
		.executeTakeFirstOrThrow();
	expect(row.actor).toMatch(/^user:[0-9a-f-]{36}$/);
	expect(row.result).toBe("ok");
});

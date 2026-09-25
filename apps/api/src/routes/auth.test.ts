import { createOidcClient } from "@portikus/auth";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	MOCK_ENTRA_TENANT,
	MOCK_GOOGLE_DOMAIN,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import type { ApiConfig } from "@portikus/config";
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
	expect(me.json().signInName).toBe("alice");
});

test.skipIf(skip)(
	"the sign-in name is the username, or the subject when there is none",
	async () => {
		const jar = new CookieJar();
		await loginAs(app, "alice", jar);
		const me = () =>
			app.inject({
				method: "GET",
				url: "/auth/me",
				headers: { cookie: jar.cookieHeader() },
			});

		// A Dex subject is an opaque blob, so the username is what a student recognises.
		await testDb.db
			.updateTable("users")
			.set({ oidc_subject: "CiQwOGE4Njg0Yi1kYjg4", preferred_username: "alice7" })
			.execute();
		expect((await me()).json().signInName).toBe("alice7");

		await testDb.db.updateTable("users").set({ preferred_username: "" }).execute();
		expect((await me()).json().signInName).toBe("CiQwOGE4Njg0Yi1kYjg4");

		await testDb.db.updateTable("users").set({ preferred_username: null }).execute();
		expect((await me()).json().signInName).toBe("CiQwOGE4Njg0Yi1kYjg4");
	},
);

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
		expect(rows[0]?.metadata).toEqual({
			from: "student",
			to: "administrator",
			source: "oidc",
		});
		// Nothing secret leaves (STACK.md §15): only these keys, all short values.
		expect(Object.keys(rows[0]?.metadata ?? {}).sort()).toEqual([
			"from",
			"source",
			"to",
		]);
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

// --- Sign-in providers (docs/EPIC-14.md rulings 8 to 12, 31) ---

const ENTRA: Partial<ApiConfig> = {
	OIDC_PROVIDER: "entra",
	OIDC_ALLOWED_TENANT: MOCK_ENTRA_TENANT,
	OIDC_GROUPS_CLAIM: "roles",
	OIDC_STUDENT_GROUP: "Portikus.Student",
	OIDC_INSTRUCTOR_GROUP: "Portikus.Instructor",
	OIDC_ADMIN_GROUP: "Portikus.Administrator",
	OIDC_DEFAULT_ROLE: "none",
};

const GOOGLE: Partial<ApiConfig> = {
	OIDC_PROVIDER: "google",
	OIDC_ALLOWED_DOMAINS: MOCK_GOOGLE_DOMAIN,
	oidcAllowedDomains: [MOCK_GOOGLE_DOMAIN],
	OIDC_DEFAULT_ROLE: "student",
};

/** Sign `user` in under `overrides`; returns the status, the new user's role and the denial audit row. */
async function signInUnder(overrides: Partial<ApiConfig>, user: string) {
	const provider = buildTestServer(testDb.db, mock.issuer, overrides);
	await provider.ready();
	try {
		const jar = new CookieJar();
		const result = await loginAs(provider, user, jar);
		const row = await testDb.db
			.selectFrom("users")
			.select("role")
			.where("oidc_subject", "=", user)
			.executeTakeFirst();
		const denied = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "auth.login")
			.where("result", "=", "denied")
			.execute();
		return {
			status: result.status,
			session: jar.get("portikus_session"),
			role: row?.role ?? null,
			denied,
		};
	} finally {
		await provider.close();
	}
}

async function expectRefused(
	overrides: Partial<ApiConfig>,
	user: string,
	reason?: string,
) {
	const result = await signInUnder(overrides, user);
	expect(result.status).toBe(403);
	expect(result.session).toBeUndefined();
	expect(result.role).toBeNull();
	expect(result.denied).toHaveLength(1);
	expect(result.denied[0]?.actor).toBe(`subject:${user}`);
	const metadata = result.denied[0]?.metadata as Record<string, unknown>;
	if (reason) expect(metadata.reason).toBe(reason);
	else expect(metadata.reason).toBeUndefined();
}

test.skipIf(skip)(
	"Entra: erin, from the tenant with a student app role, is a student",
	async () => {
		const result = await signInUnder(ENTRA, "erin");
		expect(result.status).toBe(302);
		expect(result.role).toBe("student");
		expect(result.denied).toHaveLength(0);
	},
);

test.skipIf(skip)(
	"Entra: eve, from another tenant, is refused as tenant_not_allowed",
	async () => {
		await expectRefused(ENTRA, "eve", "tenant_not_allowed");
	},
);

test.skipIf(skip)(
	"Entra: a token with no tid is refused as tenant_not_allowed",
	async () => {
		// gina's token has no tid at all.
		await expectRefused(ENTRA, "gina", "tenant_not_allowed");
	},
);

test.skipIf(skip)(
	"Entra: ian, in the tenant with no app role, gets no account",
	async () => {
		await expectRefused(ENTRA, "ian");
	},
);

test.skipIf(skip)(
	"Entra with OIDC_DEFAULT_ROLE=student admits ian as a student",
	async () => {
		const result = await signInUnder({ ...ENTRA, OIDC_DEFAULT_ROLE: "student" }, "ian");
		expect(result.status).toBe(302);
		expect(result.role).toBe("student");
	},
);

test.skipIf(skip)(
	"Google: gina, from the domain, is a student and never more",
	async () => {
		const result = await signInUnder(GOOGLE, "gina");
		expect(result.status).toBe(302);
		expect(result.role).toBe("student");
	},
);

test.skipIf(skip)(
	"Google: gabe, from another domain, is refused as domain_not_allowed",
	async () => {
		await expectRefused(GOOGLE, "gabe", "domain_not_allowed");
	},
);

test.skipIf(skip)(
	"Google: gus, with no hd, is refused as domain_not_allowed",
	async () => {
		await expectRefused(GOOGLE, "gus", "domain_not_allowed");
	},
);

test.skipIf(skip)("Google: the login redirect hints the first domain", async () => {
	const provider = buildTestServer(testDb.db, mock.issuer, GOOGLE);
	try {
		const res = await provider.inject({ method: "GET", url: "/auth/login" });
		const location = new URL(String(res.headers.location));
		expect(location.searchParams.get("hd")).toBe(MOCK_GOOGLE_DOMAIN);
	} finally {
		await provider.close();
	}
});

test.skipIf(skip)("generic OIDC sends no hd hint", async () => {
	const res = await app.inject({ method: "GET", url: "/auth/login" });
	expect(new URL(String(res.headers.location)).searchParams.has("hd")).toBe(false);
});

test.skipIf(skip)(
	"a tid or hd in userinfo does not admit an ID token that lacks it",
	async () => {
		mock.users.uma = {
			sub: "uma",
			email: "uma@example.edu",
			name: "Uma Userinfo",
			groups: [],
			claims: { roles: ["Portikus.Student"] },
			userinfoClaims: { tid: MOCK_ENTRA_TENANT, hd: MOCK_GOOGLE_DOMAIN },
		};
		try {
			await expectRefused(ENTRA, "uma", "tenant_not_allowed");
			await testDb.truncate();
			await expectRefused(GOOGLE, "uma", "domain_not_allowed");
		} finally {
			delete mock.users.uma;
		}
	},
);

test.skipIf(skip)(
	"OIDC_DEFAULT_ROLE=none refuses a generic OIDC user with no group",
	async () => {
		await expectRefused({ OIDC_DEFAULT_ROLE: "none" }, "dave");
	},
);

test.skipIf(skip)(
	"OIDC_DEFAULT_ROLE=student admits a generic OIDC user with no group as a student",
	async () => {
		const result = await signInUnder({ OIDC_DEFAULT_ROLE: "student" }, "dave");
		expect(result.status).toBe(302);
		expect(result.role).toBe("student");
	},
);

test.skipIf(skip)(
	"a matching group still wins over OIDC_DEFAULT_ROLE=student",
	async () => {
		const result = await signInUnder({ OIDC_DEFAULT_ROLE: "student" }, "carol");
		expect(result.role).toBe("administrator");
	},
);

test.skipIf(skip)(
	"a refused provider sign-in matches no existing account by email",
	async () => {
		// An account already holding gabe's email must not let gabe in.
		await testDb.db
			.insertInto("users")
			.values({
				oidc_issuer: mock.issuer,
				oidc_subject: "someone-else",
				email: "gabe@elsewhere.example.org",
				display_name: "Existing",
				role: "student",
				provider_role: "student",
			})
			.execute();
		const result = await signInUnder(GOOGLE, "gabe");
		expect(result.status).toBe(403);
		expect(result.session).toBeUndefined();
		const sessions = await testDb.db.selectFrom("sessions").select("id").execute();
		expect(sessions).toHaveLength(0);
	},
);

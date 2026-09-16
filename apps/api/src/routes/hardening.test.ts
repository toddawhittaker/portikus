import {
	CookieJar,
	csrfHeaders,
	loginAs,
	MOCK_USERS,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/**
 * Adversarial probes for the deny-by-default rules of SPEC.md §5.3 and
 * §24.3: the exemption list, cookie forgery, session expiry, and CSRF.
 */

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

// --- exemption precision -------------------------------------------------

const nearMisses: Array<[string, string, string]> = [
	["GET", "/healthx", "a path that merely starts like /health"],
	["GET", "/health/../workspaces", "a dot-segment escape out of /health"],
	["HEAD", "/health", "the HEAD twin of the exempt GET"],
	["GET", "/auth/../workspaces", "a dot-segment escape out of /auth/"],
	["GET", "/health/", "a trailing slash on the exempt path"],
	["GET", "/HEALTH", "a case variant of the exempt path"],
	["GET", "/workspaces?next=/auth/", "a query string that looks exempt"],
];

for (const [method, url, why] of nearMisses) {
	test.skipIf(skip)(
		`${method} ${url} is never 200 without a session (${why})`,
		async () => {
			const res = await app.inject({ method: method as "GET", url });
			expect(res.statusCode).not.toBe(200);
			expect([400, 401, 404]).toContain(res.statusCode);
		},
	);
}

test.skipIf(skip)("GET /health with no session is the only 200", async () => {
	const res = await app.inject({ method: "GET", url: "/health" });
	expect(res.statusCode).toBe(200);
});

// --- cookie forgery and expiry ------------------------------------------

test.skipIf(skip)("a forged session cookie is refused and cleared", async () => {
	const res = await app.inject({
		method: "GET",
		url: "/auth/me",
		headers: { cookie: "portikus_session=totally-made-up-token" },
	});
	expect(res.statusCode).toBe(401);
	expect(String(res.headers["set-cookie"] ?? "")).toMatch(/portikus_session=;/);
});

test.skipIf(skip)("a truncated real session cookie is refused", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);
	const real = jar.get("portikus_session") as string;

	for (const forged of [real.slice(0, real.length - 1), real.slice(1), `${real}x`]) {
		const res = await app.inject({
			method: "GET",
			url: "/auth/me",
			headers: { cookie: `portikus_session=${forged}` },
		});
		expect(res.statusCode).toBe(401);
	}
});

test.skipIf(skip)("an expired session is refused and its row removed", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	await testDb.db
		.updateTable("sessions")
		.set({ expires_at: new Date(Date.now() - 1000).toISOString() })
		.execute();

	const res = await app.inject({
		method: "GET",
		url: "/auth/me",
		headers: { cookie: jar.cookieHeader() },
	});
	expect(res.statusCode).toBe(401);

	const rows = await testDb.db.selectFrom("sessions").selectAll().execute();
	expect(rows).toHaveLength(0);
});

// --- CSRF ----------------------------------------------------------------

const unsafeRoutes = ["/auth/logout", "/workspaces"];

for (const url of unsafeRoutes) {
	test.skipIf(skip)(`POST ${url} with Origin: null is 403`, async () => {
		const jar = new CookieJar();
		await loginAs(app, "alice", jar);
		const res = await app.inject({
			method: "POST",
			url,
			headers: { cookie: jar.cookieHeader(), origin: "null" },
		});
		expect(res.statusCode).toBe(403);
	});

	test.skipIf(skip)(
		`POST ${url} with Sec-Fetch-Site: cross-site and a foreign Origin is 403`,
		async () => {
			const jar = new CookieJar();
			await loginAs(app, "alice", jar);
			const res = await app.inject({
				method: "POST",
				url,
				headers: {
					cookie: jar.cookieHeader(),
					origin: "https://evil.example.com",
					"sec-fetch-site": "cross-site",
				},
			});
			expect(res.statusCode).toBe(403);
		},
	);

	test.skipIf(skip)(
		`POST ${url} with Sec-Fetch-Site: cross-site and no Origin is 403`,
		async () => {
			const jar = new CookieJar();
			await loginAs(app, "alice", jar);
			const res = await app.inject({
				method: "POST",
				url,
				headers: { cookie: jar.cookieHeader(), "sec-fetch-site": "cross-site" },
			});
			expect(res.statusCode).toBe(403);
		},
	);

	test.skipIf(skip)(
		`POST ${url} with a matching Origin but Sec-Fetch-Site: cross-site is 403`,
		async () => {
			// Explicit cross-site fetch metadata always loses: the Origin
			// match is only a fallback for clients that send no metadata.
			const jar = new CookieJar();
			await loginAs(app, "alice", jar);
			const res = await app.inject({
				method: "POST",
				url,
				headers: {
					cookie: jar.cookieHeader(),
					origin: new URL(PUBLIC_URL).origin,
					"sec-fetch-site": "cross-site",
				},
			});
			expect(res.statusCode).toBe(403);
		},
	);

	test.skipIf(skip)(`POST ${url} with no origin evidence at all is 403`, async () => {
		const jar = new CookieJar();
		await loginAs(app, "alice", jar);
		const res = await app.inject({
			method: "POST",
			url,
			headers: { cookie: jar.cookieHeader() },
		});
		expect(res.statusCode).toBe(403);
	});
}

test.skipIf(skip)(
	"a cross-origin POST without a session is refused by the CSRF check",
	async () => {
		const res = await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: { origin: "https://evil.example.com" },
		});
		expect(res.statusCode).toBe(403);
	},
);

test.skipIf(skip)(
	"logout accepts a non-empty urlencoded body without acting on it",
	async () => {
		const jar = new CookieJar();
		await loginAs(app, "alice", jar);

		const res = await app.inject({
			method: "POST",
			url: "/auth/logout",
			headers: {
				...csrfHeaders(jar, PUBLIC_URL),
				"content-type": "application/x-www-form-urlencoded",
			},
			payload: "redirect=https%3A%2F%2Fevil.example.com&role=administrator",
		});

		expect(res.statusCode).toBe(303);
		expect(res.headers.location).toBe("/");
		expect(await testDb.db.selectFrom("sessions").selectAll().execute()).toHaveLength(
			0,
		);
		// The body must not have been able to change the user's role.
		const users = await testDb.db.selectFrom("users").selectAll().execute();
		expect(users[0]?.role).toBe("student");
	},
);

// --- login callback ------------------------------------------------------

test.skipIf(skip)("replaying the callback with the same code is refused", async () => {
	const jar = new CookieJar();
	const start = await app.inject({ method: "GET", url: "/auth/login" });
	jar.capture(start);

	const pick = new URL(start.headers.location as string);
	pick.searchParams.set("user", "alice");
	const chosen = await fetch(pick, { redirect: "manual" });
	const callback = new URL(chosen.headers.get("location") as string);
	const callbackPath = `${callback.pathname}${callback.search}`;

	const first = await app.inject({
		method: "GET",
		url: callbackPath,
		headers: { cookie: jar.cookieHeader() },
	});
	expect(first.statusCode).toBe(302);

	// The login cookie is cleared on success, so a replay needs the original.
	const replay = await app.inject({
		method: "GET",
		url: callbackPath,
		headers: { cookie: String(start.headers["set-cookie"]) },
	});
	expect(replay.statusCode).toBe(401);

	const sessions = await testDb.db.selectFrom("sessions").selectAll().execute();
	expect(sessions).toHaveLength(1);
});

test.skipIf(skip)(
	"a callback whose login cookie belongs to another attempt is refused",
	async () => {
		const startA = await app.inject({ method: "GET", url: "/auth/login" });
		const startB = await app.inject({ method: "GET", url: "/auth/login" });

		const pick = new URL(startA.headers.location as string);
		pick.searchParams.set("user", "alice");
		const chosen = await fetch(pick, { redirect: "manual" });
		const callback = new URL(chosen.headers.get("location") as string);

		// B's cookie carries a different state and nonce than A's code.
		const res = await app.inject({
			method: "GET",
			url: `${callback.pathname}${callback.search}`,
			headers: { cookie: String(startB.headers["set-cookie"]) },
		});
		expect(res.statusCode).toBe(401);
		expect(await testDb.db.selectFrom("sessions").selectAll().execute()).toHaveLength(
			0,
		);
	},
);

// --- roles ---------------------------------------------------------------

test.skipIf(skip)("re-login after a group change downgrades the role", async () => {
	const movable = {
		...MOCK_USERS,
		erin: {
			sub: "erin",
			email: "erin@example.edu",
			name: "Erin Mover",
			groups: ["portikus-administrators"],
		},
	};
	const provider = await startMockOidcProvider({ users: movable });
	const scoped = buildTestServer(testDb.db, provider.issuer);
	await scoped.ready();
	try {
		const jar = new CookieJar();
		await loginAs(scoped, "erin", jar);
		const first = await scoped.inject({
			method: "GET",
			url: "/auth/me",
			headers: { cookie: jar.cookieHeader() },
		});
		expect(first.json().role).toBe("administrator");

		movable.erin.groups = ["portikus-students"];

		const again = new CookieJar();
		await loginAs(scoped, "erin", again);
		const me = await scoped.inject({
			method: "GET",
			url: "/auth/me",
			headers: { cookie: again.cookieHeader() },
		});
		expect(me.json().role).toBe("student");

		const rows = await testDb.db
			.selectFrom("users")
			.selectAll()
			.where("oidc_subject", "=", "erin")
			.execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.role).toBe("student");

		// The older session must not keep the powers the user has lost.
		const admin = await scoped.inject({
			method: "GET",
			url: "/admin/workspaces",
			headers: { cookie: jar.cookieHeader() },
		});
		expect(admin.statusCode).toBe(403);
	} finally {
		await scoped.close();
		await provider.close();
	}
});

test.skipIf(skip)(
	"an administrator acting on another user's workspace is audited as the administrator",
	async () => {
		const alice = new CookieJar();
		await loginAs(app, "alice", alice);
		const workspace = (
			await app.inject({
				method: "POST",
				url: "/workspaces",
				headers: csrfHeaders(alice, PUBLIC_URL),
			})
		).json();

		const carol = new CookieJar();
		await loginAs(app, "carol", carol);
		const carolId = (
			await app.inject({
				method: "GET",
				url: "/auth/me",
				headers: { cookie: carol.cookieHeader() },
			})
		).json().id;

		const read = await app.inject({
			method: "GET",
			url: `/workspaces/${workspace.id}`,
			headers: { cookie: carol.cookieHeader() },
		});
		expect(read.statusCode).toBe(200);
		expect(read.json().ownerUserId).toBe(workspace.ownerUserId);
		expect(read.json().ownerUserId).not.toBe(carolId);

		const stop = await app.inject({
			method: "POST",
			url: `/workspaces/${workspace.id}/stop`,
			headers: csrfHeaders(carol, PUBLIC_URL),
		});
		expect(stop.statusCode).toBe(202);

		const rows = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "workspace.stop_requested")
			.execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.actor).toBe(`user:${carolId}`);
	},
);

// --- the one-workspace-per-user cap -------------------------------------

test.skipIf(skip)("five concurrent creates still make one workspace", async () => {
	const jar = new CookieJar();
	await loginAs(app, "alice", jar);

	const results = await Promise.all(
		Array.from({ length: 5 }, () =>
			app.inject({
				method: "POST",
				url: "/workspaces",
				headers: csrfHeaders(jar, PUBLIC_URL),
			}),
		),
	);

	const rows = await testDb.db.selectFrom("workspaces").selectAll().execute();
	expect(rows).toHaveLength(1);
	for (const res of results) {
		expect([200, 201]).toContain(res.statusCode);
		expect(res.json().id).toBe(rows[0]?.id);
	}
});

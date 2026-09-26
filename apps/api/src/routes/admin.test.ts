import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import type { AdminUser } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiUser,
	type TestDb,
} from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
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

// --- The runtime log level (ADR 0012, SPEC.md §25.6) ---

test.skipIf(skip)("the log level starts unset and can be set and cleared", async () => {
	await seedSettings();
	const jar = await adminJar();

	const before = await app.inject({
		method: "GET",
		url: "/admin/settings",
		headers: { cookie: jar.cookieHeader() },
	});
	expect(before.json().logLevel).toBeNull();

	const set = await app.inject({
		method: "PUT",
		url: "/admin/settings",
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: { logLevel: "debug" },
	});
	expect(set.statusCode).toBe(200);
	expect(set.json().logLevel).toBe("debug");
	// The grace period was not named, so it is untouched.
	expect(set.json().shutdownGraceSeconds).toBe(600);

	const cleared = await app.inject({
		method: "PUT",
		url: "/admin/settings",
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: { logLevel: null },
	});
	expect(cleared.statusCode).toBe(200);
	expect(cleared.json().logLevel).toBeNull();

	const audits = await testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "settings.log_level_updated")
		.orderBy("id")
		.execute();
	expect(audits).toHaveLength(2);
	expect(audits[0]?.metadata).toMatchObject({ from: null, to: "debug" });
	expect(audits[1]?.metadata).toMatchObject({ from: "debug", to: null });
});

test.skipIf(skip)(
	"both settings change together, each with its audit row",
	async () => {
		await seedSettings(600);
		const jar = await adminJar();

		const res = await app.inject({
			method: "PUT",
			url: "/admin/settings",
			headers: csrfHeaders(jar, PUBLIC_URL),
			payload: { shutdownGraceSeconds: 30, logLevel: "warn" },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({ shutdownGraceSeconds: 30, logLevel: "warn" });

		const actions = (
			await testDb.db
				.selectFrom("audit_events")
				.select("action")
				.where("target", "=", "settings")
				.execute()
		).map((row) => row.action);
		expect(actions.sort()).toEqual([
			"settings.log_level_updated",
			"settings.shutdown_grace_updated",
		]);
	},
);

test.skipIf(skip)(
	"a request that changes nothing or names a bad level is 400",
	async () => {
		await seedSettings();
		const jar = await adminJar();

		for (const payload of [{}, { logLevel: "verbose" }, { logLevel: 3 }]) {
			const res = await app.inject({
				method: "PUT",
				url: "/admin/settings",
				headers: csrfHeaders(jar, PUBLIC_URL),
				payload,
			});
			expect(res.statusCode).toBe(400);
			expect(res.json().code).toBe("VALIDATION_FAILED");
		}
	},
);

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

// --- Accounts: markers, disable and enable (SPEC.md §20.1, issue #302) ---

test.skipIf(skip)("a student gets 403 on every /admin route", async () => {
	// Collect the routes as the server registers them, so a new admin route
	// cannot be left out of this table.
	const probe = buildTestServer(testDb.db, mock.issuer);
	const routes: { method: string; url: string }[] = [];
	probe.addHook("onRoute", (route) => {
		const methods = Array.isArray(route.method) ? route.method : [route.method];
		for (const method of methods) {
			if (route.url.startsWith("/admin") && method !== "HEAD") {
				routes.push({ method, url: route.url });
			}
		}
	});
	await probe.ready();
	try {
		const urls = routes.map((route) => `${route.method} ${route.url}`);
		for (const known of [
			"GET /admin/workspaces",
			"GET /admin/settings",
			"PUT /admin/settings",
			"GET /admin/users",
			"PUT /admin/users/:id/settings",
			"POST /admin/users/:id/disable",
			"POST /admin/users/:id/enable",
			"POST /admin/users/:id/promote",
			"POST /admin/users/:id/demote",
			"POST /admin/users/:id/make-instructor",
			"POST /admin/users/:id/remove-instructor",
			"GET /admin/workspaces/:id",
			"POST /admin/workspaces/:id/archive",
			"POST /admin/workspaces/:id/unarchive",
			"PUT /admin/workspaces/:id/quota",
		]) {
			expect(urls).toContain(known);
		}

		const jar = new CookieJar();
		await loginAs(probe, "alice", jar);
		for (const route of routes) {
			const res = await probe.inject({
				method: route.method as "GET",
				url: route.url.replace(":id", crypto.randomUUID()),
				headers: csrfHeaders(jar, PUBLIC_URL),
				...(route.method === "GET" ? {} : { payload: {} }),
			});
			expect(res.statusCode, `${route.method} ${route.url}`).toBe(403);
		}
	} finally {
		await probe.close();
	}
});

async function userId(name: string): Promise<string> {
	const row = await testDb.db
		.selectFrom("users")
		.select("id")
		.where("display_name", "like", `${name}%`)
		.executeTakeFirstOrThrow();
	return row.id;
}

test.skipIf(skip)(
	"the account list carries identity, markers and the workspace",
	async () => {
		const alice = await studentJar();
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(alice, PUBLIC_URL),
		});
		const carol = await adminJar();
		const now = Date.now();
		const day = 24 * 60 * 60 * 1000;
		// Two accounts share an email; the one with the older sign-in is stale.
		await testDb.db
			.insertInto("users")
			.values([
				{
					oidc_issuer: "https://old.example",
					oidc_subject: "bob-old",
					email: "BOB@example.edu",
					display_name: "Zed Bob Old",
					role: "student",
					last_login_at: new Date(now - 2 * day).toISOString(),
				},
				{
					oidc_issuer: "https://new.example",
					oidc_subject: "bob-new",
					email: "bob@example.edu",
					display_name: "Bob New",
					role: "student",
					last_login_at: new Date(now - day).toISOString(),
				},
				{
					oidc_issuer: "https://new.example",
					oidc_subject: "gone",
					email: "gone@example.edu",
					display_name: "Gone Student",
					role: "student",
					last_login_at: new Date(now - 31 * day).toISOString(),
				},
			])
			.execute();

		const res = await app.inject({
			method: "GET",
			url: "/admin/users",
			headers: { cookie: carol.cookieHeader() },
		});
		expect(res.statusCode).toBe(200);
		const users = res.json().users as AdminUser[];
		const names = users.map((user) => user.displayName);

		// The duplicates sit together even though their names sort apart.
		expect(names[names.indexOf("Bob New") + 1]).toBe("Zed Bob Old");

		const byName = new Map(users.map((user) => [user.displayName, user]));
		expect(byName.get("Bob New")?.markers).toEqual({
			disabled: false,
			archived: false,
			duplicateEmail: true,
			stale: false,
			linked: false,
		});
		expect(byName.get("Zed Bob Old")?.markers).toMatchObject({
			duplicateEmail: true,
			stale: true,
		});
		expect(byName.get("Gone Student")?.markers?.stale).toBe(true);
		expect(byName.get("Gone Student")?.workspace).toBeNull();

		const aliceRow = byName.get("Alice Student");
		expect(aliceRow?.issuer).toBe(mock.issuer);
		expect(aliceRow?.preferredUsername).toBe("alice");
		expect(aliceRow?.lastLoginAt).not.toBeNull();
		expect(aliceRow?.markers?.stale).toBe(false);
		expect(aliceRow?.workspace).toMatchObject({
			state: "provisioning",
			activeConnections: 0,
			quotaConfig: { homeGiB: 25, dockerGiB: 20 },
			archivedAt: null,
		});
	},
);

test.skipIf(skip)(
	"disable signs the user out, revokes previews, stops the workspace and blocks sign-in",
	async () => {
		const alice = await studentJar();
		const workspace = (
			await app.inject({
				method: "POST",
				url: "/workspaces",
				headers: csrfHeaders(alice, PUBLIC_URL),
			})
		).json();
		const aliceId = await userId("Alice");
		await testDb.db
			.updateTable("workspaces")
			.set({ desired_state: "running" })
			.where("id", "=", workspace.id)
			.execute();
		const session = await testDb.db
			.selectFrom("sessions")
			.select("id")
			.where("user_id", "=", aliceId)
			.executeTakeFirstOrThrow();
		await testDb.db
			.insertInto("preview_sessions")
			.values({
				token_hash: "hash-disable",
				user_id: aliceId,
				session_id: session.id,
				workspace_id: workspace.id,
				port: 3000,
				preview_host: "x.preview.localhost",
			})
			.execute();

		const carol = await adminJar();
		const res = await app.inject({
			method: "POST",
			url: `/admin/users/${aliceId}/disable`,
			headers: csrfHeaders(carol, PUBLIC_URL),
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().disabledAt).not.toBeNull();

		// The student's next request is refused.
		const next = await app.inject({
			method: "GET",
			url: `/workspaces/${workspace.id}`,
			headers: { cookie: alice.cookieHeader() },
		});
		expect(next.statusCode).toBe(401);

		const sessions = await testDb.db
			.selectFrom("sessions")
			.select("id")
			.where("user_id", "=", aliceId)
			.execute();
		expect(sessions).toHaveLength(0);
		// No preview session of theirs is left live (the rows die with the sessions).
		const livePreviews = await testDb.db
			.selectFrom("preview_sessions")
			.select("id")
			.where("user_id", "=", aliceId)
			.where("revoked_at", "is", null)
			.execute();
		expect(livePreviews).toHaveLength(0);
		const row = await testDb.db
			.selectFrom("workspaces")
			.select("desired_state")
			.where("id", "=", workspace.id)
			.executeTakeFirstOrThrow();
		expect(row.desired_state).toBe("stopped");

		// A new sign-in is denied.
		expect((await loginAs(app, "alice", new CookieJar())).status).toBe(403);

		const list = await app.inject({
			method: "GET",
			url: "/admin/users",
			headers: { cookie: carol.cookieHeader() },
		});
		const listed = (list.json().users as AdminUser[]).find(
			(user) => user.id === aliceId,
		);
		expect(listed?.markers?.disabled).toBe(true);

		// Enable lets sign-in work again.
		const enabled = await app.inject({
			method: "POST",
			url: `/admin/users/${aliceId}/enable`,
			headers: csrfHeaders(carol, PUBLIC_URL),
		});
		expect(enabled.statusCode).toBe(200);
		expect(enabled.json().disabledAt).toBeNull();
		expect((await loginAs(app, "alice", new CookieJar())).status).toBe(302);

		const audits = await testDb.db
			.selectFrom("audit_events")
			.select(["action", "actor"])
			.where("target", "=", aliceId)
			.where("action", "in", ["user.disabled", "user.enabled"])
			.orderBy("id")
			.execute();
		const carolId = await userId("Carol");
		expect(audits).toEqual([
			{ action: "user.disabled", actor: `user:${carolId}` },
			{ action: "user.enabled", actor: `user:${carolId}` },
		]);
	},
);

test.skipIf(skip)("an administrator cannot disable their own account", async () => {
	const carol = await adminJar();
	const res = await app.inject({
		method: "POST",
		url: `/admin/users/${await userId("Carol")}/disable`,
		headers: csrfHeaders(carol, PUBLIC_URL),
	});
	expect(res.statusCode).toBe(400);
	expect(res.json().code).toBe("VALIDATION_FAILED");
});

test.skipIf(skip)("disable and enable answer 404 and 400 for bad ids", async () => {
	const carol = await adminJar();
	for (const action of ["disable", "enable"]) {
		const missing = await app.inject({
			method: "POST",
			url: `/admin/users/${crypto.randomUUID()}/${action}`,
			headers: csrfHeaders(carol, PUBLIC_URL),
		});
		expect(missing.statusCode).toBe(404);
		const bad = await app.inject({
			method: "POST",
			url: `/admin/users/not-a-uuid/${action}`,
			headers: csrfHeaders(carol, PUBLIC_URL),
		});
		expect(bad.statusCode).toBe(400);
	}
});

test.skipIf(skip)(
	"two administrators disabling each other at once leave one enabled",
	async () => {
		const carol = await adminJar();
		const alice = await studentJar();
		const carolId = await userId("Carol");
		const aliceId = await userId("Alice");
		await testDb.db
			.updateTable("users")
			.set({ role: "administrator" })
			.where("id", "=", aliceId)
			.execute();

		// Hold the users rows so both requests queue on the lock before either
		// decides; without the lock both would see the other still enabled.
		let pending: Promise<Awaited<ReturnType<typeof app.inject>>[]> | undefined;
		let waited = 0;
		await testDb.db.transaction().execute(async (trx) => {
			await sql`select 1 from users for update`.execute(trx);
			pending = Promise.all([
				app.inject({
					method: "POST",
					url: `/admin/users/${aliceId}/disable`,
					headers: csrfHeaders(carol, PUBLIC_URL),
				}),
				app.inject({
					method: "POST",
					url: `/admin/users/${carolId}/disable`,
					headers: csrfHeaders(alice, PUBLIC_URL),
				}),
			]);
			for (let i = 0; i < 200; i++) {
				const waiting = await sql<{ n: number }>`
					select count(*)::int as n from pg_stat_activity
					where wait_event_type = 'Lock' and datname = current_database()`.execute(
					testDb.db,
				);
				waited = waiting.rows[0]?.n ?? 0;
				if (waited === 2) break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		});
		expect(waited).toBe(2);
		const results = await (pending as NonNullable<typeof pending>);
		expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
		const enabledAdmins = await testDb.db
			.selectFrom("users")
			.select("id")
			.where("role", "=", "administrator")
			.where("disabled_at", "is", null)
			.execute();
		expect(enabledAdmins).toHaveLength(1);
	},
);

test.skipIf(skip)(
	"the user list carries the provider role, the grant and the linked marker",
	async () => {
		const student = new CookieJar();
		await loginAs(app, "alice", student);
		const jar = await adminJar();
		const alice = await testDb.db
			.selectFrom("users")
			.select("id")
			.where("display_name", "=", "Alice Student")
			.executeTakeFirstOrThrow();
		await testDb.db
			.updateTable("users")
			.set({ granted_role: "administrator", role: "administrator" })
			.where("id", "=", alice.id)
			.execute();
		const course = await insertTestLtiUser(testDb.db);
		await testDb.db
			.insertInto("account_links")
			.values({
				course_user_id: course,
				user_id: alice.id,
				platform_issuer: "https://lms.test.invalid",
				archived_at: null,
			})
			.execute();

		const list = await app.inject({
			method: "GET",
			url: "/admin/users",
			headers: { cookie: jar.cookieHeader() },
		});
		const users = list.json().users as AdminUser[];
		expect(users.find((u) => u.id === alice.id)).toMatchObject({
			role: "administrator",
			providerRole: "student",
			grantedRole: "administrator",
			markers: { linked: false },
		});
		expect(users.find((u) => u.id === course)).toMatchObject({
			providerRole: "student",
			grantedRole: null,
			markers: { linked: true },
		});
	},
);

// --- Promote and demote (docs/archive/epics/EPIC-13-1.md ruling 23) ---

function adminPost(jar: CookieJar, url: string) {
	return app.inject({ method: "POST", url, headers: csrfHeaders(jar, PUBLIC_URL) });
}

async function roleAudits() {
	return testDb.db
		.selectFrom("audit_events")
		.select(["actor", "target", "metadata"])
		.where("action", "=", "user.role_changed")
		.orderBy("id")
		.execute();
}

test.skipIf(skip)(
	"promote grants administrator once, audited with the actor",
	async () => {
		const carol = await adminJar();
		await studentJar();
		const carolId = await userId("Carol");
		const aliceId = await userId("Alice");

		const res = await adminPost(carol, `/admin/users/${aliceId}/promote`);
		expect(res.statusCode).toBe(200);
		expect(res.json() as AdminUser).toMatchObject({
			id: aliceId,
			role: "administrator",
			providerRole: "student",
			grantedRole: "administrator",
		});
		const again = await adminPost(carol, `/admin/users/${aliceId}/promote`);
		expect(again.statusCode).toBe(200);
		expect(await roleAudits()).toEqual([
			{
				actor: `user:${carolId}`,
				target: aliceId,
				metadata: {
					from: "student",
					to: "administrator",
					source: "admin",
					ip: expect.any(String),
					userAgent: expect.any(String),
				},
			},
		]);
		// The grant survives alice's next sign-in.
		const alice = new CookieJar();
		await loginAs(app, "alice", alice);
		const me = await app.inject({
			url: "/auth/me",
			headers: { cookie: alice.cookieHeader() },
		});
		expect(me.json().role).toBe("administrator");
	},
);

test.skipIf(skip)(
	"promote refuses a course account; bad ids are 404 and 400",
	async () => {
		const carol = await adminJar();
		const courseId = await insertTestLtiUser(testDb.db);
		const res = await adminPost(carol, `/admin/users/${courseId}/promote`);
		expect(res.statusCode).toBe(400);
		expect(res.json().message).toBe("Only SSO accounts can be administrators.");
		for (const action of ["promote", "demote"]) {
			const missing = await adminPost(
				carol,
				`/admin/users/${crypto.randomUUID()}/${action}`,
			);
			expect(missing.statusCode).toBe(404);
			const bad = await adminPost(carol, `/admin/users/not-a-uuid/${action}`);
			expect(bad.statusCode).toBe(400);
		}
		expect(await roleAudits()).toEqual([]);
	},
);

test.skipIf(skip)("demote removes a grant and returns the provider role", async () => {
	const carol = await adminJar();
	await studentJar();
	const carolId = await userId("Carol");
	const aliceId = await userId("Alice");
	await adminPost(carol, `/admin/users/${aliceId}/promote`);
	const res = await adminPost(carol, `/admin/users/${aliceId}/demote`);
	expect(res.statusCode).toBe(200);
	expect(res.json()).toMatchObject({ role: "student", grantedRole: null });
	expect((await roleAudits())[1]).toMatchObject({
		actor: `user:${carolId}`,
		target: aliceId,
		metadata: { from: "administrator", to: "student", source: "admin" },
	});
});

test.skipIf(skip)(
	"demote refuses oneself, a provider administrator, and a non-administrator",
	async () => {
		const carol = await adminJar();
		await studentJar();
		const carolId = await userId("Carol");
		const aliceId = await userId("Alice");

		const self = await adminPost(carol, `/admin/users/${carolId}/demote`);
		expect(self.statusCode).toBe(400);
		expect(self.json().message).toBe("You cannot demote your own account.");

		const student = await adminPost(carol, `/admin/users/${aliceId}/demote`);
		expect(student.statusCode).toBe(400);

		await adminPost(carol, `/admin/users/${aliceId}/promote`);
		const alice = new CookieJar();
		await loginAs(app, "alice", alice);
		const provider = await adminPost(alice, `/admin/users/${carolId}/demote`);
		expect(provider.statusCode).toBe(400);
		expect(provider.json().message).toBe(
			"This administrator comes from the SSO provider's groups.",
		);
	},
);

test.skipIf(skip)(
	"demoting a provider administrator who also holds a grant changes no role and writes no audit",
	async () => {
		const carol = await adminJar();
		await studentJar();
		const carolId = await userId("Carol");
		const aliceId = await userId("Alice");
		await adminPost(carol, `/admin/users/${aliceId}/promote`);
		await testDb.db
			.updateTable("users")
			.set({ granted_role: "administrator" })
			.where("id", "=", carolId)
			.execute();
		const alice = new CookieJar();
		await loginAs(app, "alice", alice);
		const res = await adminPost(alice, `/admin/users/${carolId}/demote`);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({ role: "administrator", grantedRole: null });
		// Only alice's promotion is on record.
		expect(await roleAudits()).toHaveLength(1);
	},
);

test.skipIf(skip)(
	"two granted administrators demoting each other at once leave one administrator",
	async () => {
		await adminJar();
		await studentJar();
		await loginAs(app, "bob", new CookieJar());
		const aliceId = await userId("Alice");
		const bobId = await userId("Bob");
		await testDb.db
			.updateTable("users")
			.set({ granted_role: "administrator", role: "administrator" })
			.where("id", "in", [aliceId, bobId])
			.execute();
		// Only the two granted administrators remain.
		await testDb.db
			.updateTable("users")
			.set({ role: "student", provider_role: "student" })
			.where("display_name", "like", "Carol%")
			.execute();
		const alice = new CookieJar();
		await loginAs(app, "alice", alice);
		const bob = new CookieJar();
		await loginAs(app, "bob", bob);

		let pending: Promise<Awaited<ReturnType<typeof app.inject>>[]> | undefined;
		let waited = 0;
		await testDb.db.transaction().execute(async (trx) => {
			await sql`select 1 from users for update`.execute(trx);
			pending = Promise.all([
				adminPost(alice, `/admin/users/${bobId}/demote`),
				adminPost(bob, `/admin/users/${aliceId}/demote`),
			]);
			for (let i = 0; i < 200; i++) {
				const waiting = await sql<{ n: number }>`
					select count(*)::int as n from pg_stat_activity
					where wait_event_type = 'Lock' and datname = current_database()`.execute(
					testDb.db,
				);
				waited = waiting.rows[0]?.n ?? 0;
				if (waited === 2) break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		});
		expect(waited).toBe(2);
		const results = await (pending as NonNullable<typeof pending>);
		expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
		const refused = results.find((r) => r.statusCode === 400);
		expect(refused?.json().message).toBe(
			"At least one other enabled administrator must remain.",
		);
		const admins = await testDb.db
			.selectFrom("users")
			.select("id")
			.where("role", "=", "administrator")
			.execute();
		expect(admins).toHaveLength(1);
	},
);

// --- Make and remove instructor (docs/archive/epics/EPIC-14.md ruling 14) ---

test.skipIf(skip)(
	"make instructor grants instructor once, audited, and survives the next sign-in",
	async () => {
		const carol = await adminJar();
		await studentJar();
		const carolId = await userId("Carol");
		const aliceId = await userId("Alice");

		const res = await adminPost(carol, `/admin/users/${aliceId}/make-instructor`);
		expect(res.statusCode).toBe(200);
		expect(res.json() as AdminUser).toMatchObject({
			id: aliceId,
			role: "instructor",
			providerRole: "student",
			grantedRole: "instructor",
		});
		const again = await adminPost(carol, `/admin/users/${aliceId}/make-instructor`);
		expect(again.statusCode).toBe(200);
		expect(await roleAudits()).toEqual([
			{
				actor: `user:${carolId}`,
				target: aliceId,
				metadata: {
					from: "student",
					to: "instructor",
					source: "admin",
					ip: expect.any(String),
					userAgent: expect.any(String),
				},
			},
		]);
		// The grant survives alice's next sign-in.
		const alice = new CookieJar();
		await loginAs(app, "alice", alice);
		const me = await app.inject({
			url: "/auth/me",
			headers: { cookie: alice.cookieHeader() },
		});
		expect(me.json().role).toBe("instructor");
	},
);

test.skipIf(skip)("make instructor keeps the account's sessions", async () => {
	const carol = await adminJar();
	const alice = await studentJar();
	const aliceId = await userId("Alice");
	await adminPost(carol, `/admin/users/${aliceId}/make-instructor`);
	const me = await app.inject({
		url: "/auth/me",
		headers: { cookie: alice.cookieHeader() },
	});
	expect(me.statusCode).toBe(200);
	expect(me.json().role).toBe("instructor");
});

test.skipIf(skip)(
	"make instructor leaves a provider administrator alone and refuses a granted one",
	async () => {
		const carol = await adminJar();
		await studentJar();
		const carolId = await userId("Carol");
		const aliceId = await userId("Alice");

		const provider = await adminPost(carol, `/admin/users/${carolId}/make-instructor`);
		expect(provider.statusCode).toBe(200);
		expect(provider.json()).toMatchObject({ role: "administrator", grantedRole: null });

		await adminPost(carol, `/admin/users/${aliceId}/promote`);
		const granted = await adminPost(carol, `/admin/users/${aliceId}/make-instructor`);
		expect(granted.statusCode).toBe(400);
		expect(granted.json().message).toBe("Demote first.");
		const remove = await adminPost(carol, `/admin/users/${aliceId}/remove-instructor`);
		expect(remove.statusCode).toBe(400);
		// Only the promotion is on record; the administrator grant is untouched.
		expect(await roleAudits()).toHaveLength(1);
		const row = await testDb.db
			.selectFrom("users")
			.select(["role", "granted_role"])
			.where("id", "=", aliceId)
			.executeTakeFirstOrThrow();
		expect(row).toEqual({ role: "administrator", granted_role: "administrator" });
	},
);

test.skipIf(skip)(
	"make and remove instructor refuse a course account; bad ids are 404 and 400",
	async () => {
		const carol = await adminJar();
		const courseId = await insertTestLtiUser(testDb.db);
		const make = await adminPost(carol, `/admin/users/${courseId}/make-instructor`);
		expect(make.statusCode).toBe(400);
		expect(make.json().message).toBe("Only SSO accounts can be instructors.");
		const remove = await adminPost(carol, `/admin/users/${courseId}/remove-instructor`);
		expect(remove.statusCode).toBe(400);
		for (const action of ["make-instructor", "remove-instructor"]) {
			const missing = await adminPost(
				carol,
				`/admin/users/${crypto.randomUUID()}/${action}`,
			);
			expect(missing.statusCode).toBe(404);
			const bad = await adminPost(carol, `/admin/users/not-a-uuid/${action}`);
			expect(bad.statusCode).toBe(400);
		}
		expect(await roleAudits()).toEqual([]);
	},
);

test.skipIf(skip)(
	"remove instructor clears the grant and returns the provider role",
	async () => {
		const carol = await adminJar();
		await studentJar();
		const carolId = await userId("Carol");
		const aliceId = await userId("Alice");
		await adminPost(carol, `/admin/users/${aliceId}/make-instructor`);
		const res = await adminPost(carol, `/admin/users/${aliceId}/remove-instructor`);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({ role: "student", grantedRole: null });
		expect((await roleAudits())[1]).toMatchObject({
			actor: `user:${carolId}`,
			target: aliceId,
			metadata: { from: "instructor", to: "student", source: "admin" },
		});
		const none = await adminPost(carol, `/admin/users/${aliceId}/remove-instructor`);
		expect(none.statusCode).toBe(400);
		expect(none.json().message).toBe("This account has no instructor grant.");
	},
);

test.skipIf(skip)("a student cannot make anyone an instructor", async () => {
	const alice = await studentJar();
	const aliceId = await userId("Alice");
	const res = await adminPost(alice, `/admin/users/${aliceId}/make-instructor`);
	expect(res.statusCode).toBe(403);
});

// --- Resource guard and acceptable-use settings (SPEC.md §24.11) ---

test.skipIf(skip)(
	"the guard settings are saved, audited together, and read back",
	async () => {
		await seedSettings();
		const jar = await adminJar();

		const put = await app.inject({
			method: "PUT",
			url: "/admin/settings",
			headers: csrfHeaders(jar, PUBLIC_URL),
			payload: {
				cpuGuardThresholdPercent: 70,
				memoryGuardThresholdPercent: 95,
				guardWindowMinutes: 15,
				cpuThrottleSharePercent: 50,
				idleStopMinutes: 0,
			},
		});
		expect(put.statusCode).toBe(200);
		expect(put.json()).toMatchObject({
			cpuGuardThresholdPercent: 70,
			memoryGuardThresholdPercent: 95,
			guardWindowMinutes: 15,
			cpuThrottleSharePercent: 50,
			idleStopMinutes: 0,
			shutdownGraceSeconds: 600,
		});

		const after = await app.inject({
			method: "GET",
			url: "/admin/settings",
			headers: { cookie: jar.cookieHeader() },
		});
		expect(after.json()).toMatchObject({
			cpuGuardThresholdPercent: 70,
			idleStopMinutes: 0,
		});

		const guard = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "settings.resource_guard_updated")
			.execute();
		expect(guard).toHaveLength(1);
		expect(guard[0]?.metadata).toMatchObject({
			from: {
				cpuGuardThresholdPercent: 80,
				memoryGuardThresholdPercent: 90,
				guardWindowMinutes: 30,
				cpuThrottleSharePercent: 25,
			},
			to: {
				cpuGuardThresholdPercent: 70,
				memoryGuardThresholdPercent: 95,
				guardWindowMinutes: 15,
				cpuThrottleSharePercent: 50,
			},
		});
		const idle = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "settings.idle_stop_updated")
			.execute();
		expect(idle).toHaveLength(1);
		expect(idle[0]?.metadata).toMatchObject({ from: 60, to: 0 });
	},
);

test.skipIf(skip)(
	"the guard audit row names only the fields that were sent",
	async () => {
		await seedSettings();
		const jar = await adminJar();
		const put = await app.inject({
			method: "PUT",
			url: "/admin/settings",
			headers: csrfHeaders(jar, PUBLIC_URL),
			payload: { guardWindowMinutes: 45 },
		});
		expect(put.statusCode).toBe(200);
		expect(put.json().cpuGuardThresholdPercent).toBe(80);
		const rows = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("target", "=", "settings")
			.execute();
		expect(rows.map((row) => row.action)).toEqual(["settings.resource_guard_updated"]);
		const metadata = rows[0]?.metadata as { from: object; to: object };
		expect(metadata.from).toEqual({ guardWindowMinutes: 30 });
		expect(metadata.to).toEqual({ guardWindowMinutes: 45 });
	},
);

test.skipIf(skip)(
	"a save that changes nothing writes no guard or idle stop audit row",
	async () => {
		await seedSettings();
		const jar = await adminJar();
		const put = await app.inject({
			method: "PUT",
			url: "/admin/settings",
			headers: csrfHeaders(jar, PUBLIC_URL),
			payload: {
				cpuGuardThresholdPercent: 80,
				memoryGuardThresholdPercent: 90,
				guardWindowMinutes: 45,
				cpuThrottleSharePercent: 25,
				idleStopMinutes: 60,
			},
		});
		expect(put.statusCode).toBe(200);
		const rows = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("target", "=", "settings")
			.execute();
		expect(rows.map((row) => row.action)).toEqual(["settings.resource_guard_updated"]);
		const metadata = rows[0]?.metadata as { from: object; to: object };
		expect(metadata.from).toEqual({ guardWindowMinutes: 30 });
		expect(metadata.to).toEqual({ guardWindowMinutes: 45 });

		const again = await app.inject({
			method: "PUT",
			url: "/admin/settings",
			headers: csrfHeaders(jar, PUBLIC_URL),
			payload: {
				cpuGuardThresholdPercent: 80,
				memoryGuardThresholdPercent: 90,
				guardWindowMinutes: 45,
				cpuThrottleSharePercent: 25,
				idleStopMinutes: 60,
			},
		});
		expect(again.statusCode).toBe(200);
		const after = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("target", "=", "settings")
			.execute();
		expect(after).toHaveLength(1);
	},
);

test.skipIf(skip)(
	"the guard settings accept their edges and refuse outside them",
	async () => {
		await seedSettings();
		const jar = await adminJar();
		const good = [
			{ cpuGuardThresholdPercent: 1 },
			{ cpuGuardThresholdPercent: 100 },
			{ memoryGuardThresholdPercent: 1 },
			{ memoryGuardThresholdPercent: 100 },
			{ guardWindowMinutes: 5 },
			{ guardWindowMinutes: 240 },
			{ cpuThrottleSharePercent: 5 },
			{ cpuThrottleSharePercent: 100 },
			{ idleStopMinutes: 0 },
			{ idleStopMinutes: 10 },
			{ idleStopMinutes: 1440 },
		];
		for (const payload of good) {
			const res = await app.inject({
				method: "PUT",
				url: "/admin/settings",
				headers: csrfHeaders(jar, PUBLIC_URL),
				payload,
			});
			expect(res.statusCode, JSON.stringify(payload)).toBe(200);
		}
		const bad = [
			{ cpuGuardThresholdPercent: 0 },
			{ cpuGuardThresholdPercent: 101 },
			{ memoryGuardThresholdPercent: 0 },
			{ memoryGuardThresholdPercent: 101 },
			{ guardWindowMinutes: 4 },
			{ guardWindowMinutes: 241 },
			{ cpuThrottleSharePercent: 4 },
			{ cpuThrottleSharePercent: 101 },
			{ idleStopMinutes: 9 },
			{ idleStopMinutes: 1441 },
			{ idleStopMinutes: -1 },
			{ guardWindowMinutes: 30.5 },
			{ acceptableUseVersion: 5 },
			{ acceptableUseText: "   " },
			{ acceptableUseText: "x".repeat(10_001) },
		];
		for (const payload of bad) {
			const res = await app.inject({
				method: "PUT",
				url: "/admin/settings",
				headers: csrfHeaders(jar, PUBLIC_URL),
				payload,
			});
			expect(res.statusCode, JSON.stringify(payload)).toBe(400);
			expect(res.json().code).toBe("VALIDATION_FAILED");
		}
	},
);

test.skipIf(skip)(
	"a changed statement bumps the version and audits versions only",
	async () => {
		await seedSettings();
		const jar = await adminJar();
		const save = (acceptableUseText: string | null) =>
			app.inject({
				method: "PUT",
				url: "/admin/settings",
				headers: csrfHeaders(jar, PUBLIC_URL),
				payload: { acceptableUseText },
			});
		// The administrator who saved a new text accepts it too (SPEC.md section 5.1).
		const accept = (version: number) =>
			app.inject({
				method: "POST",
				url: "/me/acceptable-use",
				headers: csrfHeaders(jar, PUBLIC_URL),
				payload: { version },
			});

		const first = await save("Be kind to the servers.");
		expect(first.statusCode).toBe(200);
		expect(first.json()).toMatchObject({
			acceptableUseText: "Be kind to the servers.",
			acceptableUseVersion: 2,
		});
		expect((await accept(2)).statusCode).toBe(204);

		// Saving the same text again asks nobody to accept again.
		const same = await save("Be kind to the servers.");
		expect(same.json().acceptableUseVersion).toBe(2);

		// Resetting to the default from a custom text is a change.
		const reset = await save(null);
		expect(reset.json()).toMatchObject({
			acceptableUseText: null,
			acceptableUseVersion: 3,
		});

		const rows = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "settings.acceptable_use_updated")
			.orderBy("id")
			.execute();
		expect(rows.map((row) => row.metadata)).toMatchObject([
			{ fromVersion: 1, toVersion: 2 },
			{ fromVersion: 2, toVersion: 3 },
		]);
		expect(JSON.stringify(rows)).not.toContain("Be kind");
	},
);

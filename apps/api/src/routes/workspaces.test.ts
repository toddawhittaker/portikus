import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

const skip = !hasTestDb();
let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let alice: CookieJar;

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
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
	return async () => {
		await app.close();
	};
});

function post(
	url: string,
	jar: CookieJar,
	payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
	return app.inject({
		method: "POST",
		url,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload,
	});
}

function get(url: string, jar: CookieJar): Promise<LightMyRequestResponse> {
	return app.inject({ method: "GET", url, headers: { cookie: jar.cookieHeader() } });
}

test.skipIf(skip)("POST /workspaces without a session is 401", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/workspaces",
		headers: { "sec-fetch-site": "same-origin" },
	});
	expect(res.statusCode).toBe(401);
	expect(res.json().code).toBe("UNAUTHORIZED");
});

test.skipIf(skip)(
	"POST /workspaces creates a workspace owned by the session user",
	async () => {
		const me = (await get("/auth/me", alice)).json();
		const res = await post("/workspaces", alice);

		expect(res.statusCode).toBe(201);
		const body = res.json();
		expect(body.ownerUserId).toBe(me.id);
		expect(body.state).toBe("provisioning");
		expect(body.desiredState).toBe("stopped");
		expect(body.incusInstanceName).toMatch(/^ws-[a-f0-9]{24}$/);
		expect(body.quotaConfig).toEqual({ homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 });
	},
);

test.skipIf(skip)("POST /workspaces rejects a body with any property", async () => {
	const res = await post("/workspaces", alice, { ownerUserId: "someone-else" });
	expect(res.statusCode).toBe(400);
	expect(res.json().code).toBe("VALIDATION_FAILED");
});

test.skipIf(skip)("POST /workspaces is idempotent for one user", async () => {
	const first = await post("/workspaces", alice);
	expect(first.statusCode).toBe(201);

	const second = await post("/workspaces", alice);
	expect(second.statusCode).toBe(200);
	expect(second.json().id).toBe(first.json().id);
});

test.skipIf(skip)("GET /workspaces/:id returns the owner's workspace", async () => {
	const id = (await post("/workspaces", alice)).json().id;
	const res = await get(`/workspaces/${id}`, alice);
	expect(res.statusCode).toBe(200);
	expect(res.json().id).toBe(id);
});

test.skipIf(skip)("another student gets 404 for someone else's workspace", async () => {
	const id = (await post("/workspaces", alice)).json().id;

	const bob = new CookieJar();
	await loginAs(app, "bob", bob);

	const res = await get(`/workspaces/${id}`, bob);
	expect(res.statusCode).toBe(404);
	expect(res.json().code).toBe("WORKSPACE_NOT_FOUND");

	const start = await post(`/workspaces/${id}/start`, bob);
	expect(start.statusCode).toBe(404);
});

test.skipIf(skip)("an administrator may read another user's workspace", async () => {
	const id = (await post("/workspaces", alice)).json().id;

	const carol = new CookieJar();
	await loginAs(app, "carol", carol);

	const res = await get(`/workspaces/${id}`, carol);
	expect(res.statusCode).toBe(200);
});

test.skipIf(skip)("GET /workspaces/:id is 404 for an unknown id", async () => {
	const res = await get("/workspaces/00000000-0000-0000-0000-000000000000", alice);
	expect(res.statusCode).toBe(404);
	expect(res.json().code).toBe("WORKSPACE_NOT_FOUND");
});

test.skipIf(skip)("GET /workspaces/:id is 400 for an invalid uuid", async () => {
	const res = await get("/workspaces/not-a-uuid", alice);
	expect(res.statusCode).toBe(400);
	expect(res.json().code).toBe("VALIDATION_FAILED");
});

test.skipIf(skip)(
	"start, stop, and restart set desired_state and write audit",
	async () => {
		const me = (await get("/auth/me", alice)).json();
		const id = (await post("/workspaces", alice)).json().id;

		expect((await post(`/workspaces/${id}/start`, alice)).statusCode).toBe(202);
		expect((await get(`/workspaces/${id}`, alice)).json().desiredState).toBe("running");

		expect((await post(`/workspaces/${id}/stop`, alice)).statusCode).toBe(202);
		expect((await get(`/workspaces/${id}`, alice)).json().desiredState).toBe("stopped");

		expect((await post(`/workspaces/${id}/restart`, alice)).statusCode).toBe(202);
		expect((await get(`/workspaces/${id}`, alice)).json().desiredState).toBe(
			"restarting",
		);

		const audits = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("target", "=", id)
			.execute();
		const actions = audits.map((row) => row.action);
		expect(actions).toContain("workspace.provision_requested");
		expect(actions).toContain("workspace.start_requested");
		expect(actions).toContain("workspace.stop_requested");
		expect(actions).toContain("workspace.restart_requested");
		for (const row of audits) {
			expect(row.actor).toBe(`user:${me.id}`);
		}
	},
);

test.skipIf(skip)("start is 404 for an unknown workspace", async () => {
	const res = await post(
		"/workspaces/00000000-0000-0000-0000-000000000000/start",
		alice,
	);
	expect(res.statusCode).toBe(404);
	expect(res.json().code).toBe("WORKSPACE_NOT_FOUND");
});

test.skipIf(skip)("activeConnections excludes stale rows", async () => {
	const id = (await post("/workspaces", alice)).json().id;

	const staleTime = new Date(Date.now() - 70 * 1000).toISOString();
	await testDb.db
		.insertInto("workspace_connections")
		.values({
			id: crypto.randomUUID(),
			workspace_id: id,
			last_seen_at: staleTime,
		})
		.execute();
	await testDb.db
		.insertInto("workspace_connections")
		.values({ id: crypto.randomUUID(), workspace_id: id })
		.execute();

	expect((await get(`/workspaces/${id}`, alice)).json().activeConnections).toBe(1);
});

test.skipIf(skip)("the removed connection routes are gone", async () => {
	const id = (await post("/workspaces", alice)).json().id;
	const res = await post(`/workspaces/${id}/connections`, alice);
	expect(res.statusCode).toBe(404);
});

// --- workspace label (SPEC.md Epic 8, BROWSER-HANDLING.md section 8) ---

test.skipIf(skip)("a new workspace is labelled after the login username", async () => {
	const created = await post("/workspaces", alice);
	expect(created.json().label).toBe("alice");

	const row = await testDb.db
		.selectFrom("workspaces")
		.select("label")
		.where("id", "=", created.json().id)
		.executeTakeFirstOrThrow();
	expect(row.label).toBe("alice");
});

test.skipIf(skip)("a label collision gets a numbered suffix", async () => {
	await post("/workspaces", alice);

	// Bob's provider hands back a username that reduces to the same label.
	const bob = new CookieJar();
	await loginAs(app, "bob", bob);
	await testDb.db
		.updateTable("users")
		.set({ preferred_username: "alice" })
		.where("oidc_subject", "=", "bob")
		.execute();

	expect((await post("/workspaces", bob)).json().label).toBe("alice-2");
});

test.skipIf(skip)(
	"a workspace gets the fallback label when the claim is missing",
	async () => {
		await testDb.db
			.updateTable("users")
			.set({ preferred_username: null })
			.where("oidc_subject", "=", "alice")
			.execute();

		expect((await post("/workspaces", alice)).json().label).toMatch(/^ws-[0-9a-f]{8}$/);
	},
);

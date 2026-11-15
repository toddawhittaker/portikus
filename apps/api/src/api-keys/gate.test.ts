import { createApiKey } from "@portikus/auth";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import type { ApiKeyScope } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { Operation } from "../catalog/index.js";
import { API_KEY_REQUESTS_PER_MINUTE } from "../rate-limit.js";
import {
	buildTestServer,
	MATRIX_MOCK_USERS,
	PUBLIC_URL,
} from "../testing/test-support.js";

/**
 * The scope gate (SPEC.md sections 24.8, 24.11 and 24.13): a key reaches only
 * what the catalog exposes, only up to its scope, within its own limit, and
 * every key request leaves one audit row that says it came by key.
 */

/** Records for routes whose family record may not have landed yet, so the gate has something to allow. */
const FAKE_RECORDS: Record<string, Operation> = {
	"GET /admin/users": fake("people.list_users", "read"),
	"GET /me/settings": fake("people.my_settings", "read"),
	"POST /admin/users/:id/disable": fake("people.disable_user", "change"),
	"POST /admin/invitations": fake("people.invite", "change"),
	"GET /admin/audit": fake("people.audit", "read"),
};

function fake(name: string, risk: Operation["risk"]): Operation {
	return {
		name,
		description: "A test record.",
		risk,
		audience: "administrator",
		tool: false,
		input: { body: z.unknown() },
	};
}

vi.mock("../catalog/index.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../catalog/index.js")>();
	return {
		...real,
		operationByKey: (key: string) =>
			FAKE_RECORDS[key.replace(/^HEAD /, "GET ")] ?? real.operationByKey(key),
	};
});

const skip = !hasTestDb();

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		users: MATRIX_MOCK_USERS,
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
	app = buildTestServer(testDb.db, mock.issuer, {
		ANONYMOUS_REQUEST_LIMIT_PER_MINUTE: 5,
	});
	await app.ready();
	return async () => {
		await app.close();
	};
});

async function signIn(user: string): Promise<{ jar: CookieJar; id: string }> {
	const jar = new CookieJar();
	await loginAs(app, user, jar);
	const me = await app.inject({
		method: "GET",
		url: "/auth/me",
		headers: { cookie: jar.cookieHeader() },
	});
	return { jar, id: me.json().id };
}

async function keyFor(
	userId: string,
	scope: ApiKeyScope,
): Promise<{ secret: string; id: string }> {
	const made = await createApiKey(testDb.db, userId, {
		name: `${scope} key`,
		scope,
		periodDays: 30,
	});
	if (!made.ok) throw new Error(`no key: ${made.reason}`);
	return { secret: made.secret, id: made.key.id };
}

function withKey(
	secret: string,
	method: "GET" | "HEAD" | "POST",
	url: string,
	payload?: object,
	extra: Record<string, string> = {},
) {
	return app.inject({
		method,
		url,
		headers: { authorization: `Bearer ${secret}`, ...extra },
		...(payload === undefined ? {} : { payload }),
	});
}

async function usedRows() {
	return testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "api_key.used")
		.orderBy("id")
		.execute();
}

describe.skipIf(skip)("the scope gate", () => {
	test("a read key may read an exposed operation, and HEAD counts as its GET", async () => {
		const admin = await signIn("carol");
		const key = await keyFor(admin.id, "read");
		expect((await withKey(key.secret, "GET", "/admin/users")).statusCode).toBe(200);
		expect((await withKey(key.secret, "HEAD", "/admin/users")).statusCode).toBe(200);
	});

	test("a read key on a change operation gets 403 SCOPE_REQUIRED and changes nothing", async () => {
		const admin = await signIn("carol");
		const alice = await signIn("alice");
		const key = await keyFor(admin.id, "read");
		const res = await withKey(
			key.secret,
			"POST",
			`/admin/users/${alice.id}/disable`,
			{},
		);
		expect(res.statusCode).toBe(403);
		expect(res.json().code).toBe("SCOPE_REQUIRED");
		const row = await testDb.db
			.selectFrom("users")
			.select("disabled_at")
			.where("id", "=", alice.id)
			.executeTakeFirstOrThrow();
		expect(row.disabled_at).toBeNull();
	});

	test("a write key runs the change, and the route's own audit row says it came by that key", async () => {
		const admin = await signIn("carol");
		const alice = await signIn("alice");
		const key = await keyFor(admin.id, "write");
		const res = await withKey(
			key.secret,
			"POST",
			`/admin/users/${alice.id}/disable`,
			{},
		);
		expect(res.statusCode).toBe(200);
		const row = await testDb.db
			.selectFrom("audit_events")
			.select(["actor", "via", "api_key_id"])
			.where("action", "=", "user.disabled")
			.executeTakeFirstOrThrow();
		expect(row).toEqual({
			actor: `user:${admin.id}`,
			via: "api_key",
			api_key_id: key.id,
		});
	});

	test.each([
		["POST", "/me/password", { current: "x", next: "y" }],
		["GET", "/admin/root-shell", undefined],
		["GET", "/me/api-keys", undefined],
		["GET", "/no/such/route", undefined],
	] as const)(
		"%s %s is refused to a destructive key with 403, never 500",
		async (method, url, payload) => {
			const admin = await signIn("carol");
			const key = await keyFor(admin.id, "destructive");
			const res = await withKey(key.secret, method, url, payload);
			expect(res.statusCode).toBe(403);
			expect(res.json().code).toBe("NOT_AVAILABLE_TO_API_KEYS");
		},
	);

	test("a WebSocket route is refused to a key, upgrade or not", async () => {
		const admin = await signIn("carol");
		const key = await keyFor(admin.id, "destructive");
		const url = `/workspaces/${crypto.randomUUID()}/ws`;
		const upgrades: Record<string, string>[] = [
			{},
			{ connection: "Upgrade", upgrade: "websocket" },
		];
		for (const extra of upgrades) {
			const res = await withKey(key.secret, "GET", url, undefined, extra);
			expect(res.statusCode, JSON.stringify(extra)).toBe(403);
			expect(res.json().code).toBe("NOT_AVAILABLE_TO_API_KEYS");
		}
	});
});

describe.skipIf(skip)("limits", () => {
	test("the request after the per-key limit in a minute gets 429 with Retry-After", async () => {
		const admin = await signIn("carol");
		const key = await keyFor(admin.id, "read");
		for (let i = 0; i < API_KEY_REQUESTS_PER_MINUTE; i++) {
			const res = await withKey(key.secret, "GET", "/me/settings");
			expect(res.statusCode, `request ${i + 1}`).toBe(200);
		}
		const over = await withKey(key.secret, "GET", "/me/settings");
		expect(over.statusCode).toBe(429);
		expect(over.json().code).toBe("RATE_LIMITED");
		expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
		// Another key of the same person has its own count.
		const other = await keyFor(admin.id, "read");
		expect((await withKey(other.secret, "GET", "/me/settings")).statusCode).toBe(200);
		// One row per allowed request; refusals by the limit add none.
		await expect
			.poll(async () => (await usedRows()).length)
			.toBe(API_KEY_REQUESTS_PER_MINUTE + 1);
		const rows = await usedRows();
		expect(rows.filter((r) => r.api_key_id === key.id)).toHaveLength(
			API_KEY_REQUESTS_PER_MINUTE,
		);
	});

	test("an unknown key is counted by the anonymous limit of its address", async () => {
		const made = `portikus_${"x".repeat(43)}`;
		const statuses: number[] = [];
		for (let i = 0; i < 6; i++) {
			statuses.push((await withKey(`${made}${i}`, "GET", "/me/settings")).statusCode);
		}
		expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
	});
});

describe.skipIf(skip)("audit and last use", () => {
	test("each key request writes one api_key.used row with the operation, status and key", async () => {
		const admin = await signIn("carol");
		const key = await keyFor(admin.id, "read");
		await withKey(key.secret, "GET", "/admin/users");
		await withKey(key.secret, "POST", `/admin/users/${admin.id}/disable`, {});
		// Each row is written once its response is done, which can be just after inject returns.
		await expect.poll(async () => (await usedRows()).length).toBe(2);
		const rows = await usedRows();
		expect(
			rows.map((r) => ({
				actor: r.actor,
				via: r.via,
				apiKeyId: r.api_key_id,
				result: r.result,
				operation: (r.metadata as Record<string, unknown>).operation,
				status: (r.metadata as Record<string, unknown>).status,
			})),
		).toEqual([
			{
				actor: `user:${admin.id}`,
				via: "api_key",
				apiKeyId: key.id,
				result: "ok",
				operation: "people.list_users",
				status: 200,
			},
			{
				actor: `user:${admin.id}`,
				via: "api_key",
				apiKeyId: key.id,
				result: "denied",
				operation: "people.disable_user",
				status: 403,
			},
		]);
		// The secret is never written anywhere in the row.
		expect(JSON.stringify(rows)).not.toContain(key.secret);
	});

	test("a session request's audit rows say session and name no key", async () => {
		const admin = await signIn("carol");
		const alice = await signIn("alice");
		const res = await app.inject({
			method: "POST",
			url: `/admin/users/${alice.id}/disable`,
			headers: csrfHeaders(admin.jar, PUBLIC_URL),
		});
		expect(res.statusCode).toBe(200);
		const row = await testDb.db
			.selectFrom("audit_events")
			.select(["via", "api_key_id"])
			.where("action", "=", "user.disabled")
			.executeTakeFirstOrThrow();
		expect(row).toEqual({ via: "session", api_key_id: null });
		expect(await usedRows()).toEqual([]);
	});

	test("a key request records when the key was last used", async () => {
		const admin = await signIn("carol");
		const key = await keyFor(admin.id, "read");
		await withKey(key.secret, "GET", "/me/settings");
		const row = await testDb.db
			.selectFrom("api_keys")
			.select("last_used_at")
			.where("id", "=", key.id)
			.executeTakeFirstOrThrow();
		expect(row.last_used_at).not.toBeNull();
	});

	test("the Audit tab shows how a row arrived and which key", async () => {
		const admin = await signIn("carol");
		const key = await keyFor(admin.id, "read");
		await withKey(key.secret, "GET", "/admin/users");
		await expect.poll(async () => (await usedRows()).length).toBe(1);
		const page = await app.inject({
			method: "GET",
			url: "/admin/audit?action=api_key.used",
			headers: { cookie: admin.jar.cookieHeader() },
		});
		expect(page.statusCode).toBe(200);
		expect(page.json().events[0]).toMatchObject({ via: "api_key", apiKeyId: key.id });
	});
});

describe.skipIf(skip)("invitations by key", () => {
	const invite = (role: string, n: number) => ({
		name: `Invited ${n}`,
		email: `invited${n}@example.edu`,
		role,
	});

	test("a write key may invite a student but not an instructor or administrator", async () => {
		const admin = await signIn("carol");
		const key = await keyFor(admin.id, "write");
		expect(
			(await withKey(key.secret, "POST", "/admin/invitations", invite("student", 1)))
				.statusCode,
		).toBe(201);
		for (const [n, role] of [
			[2, "instructor"],
			[3, "administrator"],
		] as const) {
			const res = await withKey(
				key.secret,
				"POST",
				"/admin/invitations",
				invite(role, n),
			);
			expect(res.statusCode, role).toBe(403);
			expect(res.json().code).toBe("SCOPE_REQUIRED");
		}
		const made = await testDb.db
			.selectFrom("account_invitations")
			.select("role")
			.where("email", "like", "invited%")
			.execute();
		expect(made.map((r) => r.role)).toEqual(["student"]);
	});

	test("a destructive key may invite an instructor", async () => {
		const admin = await signIn("carol");
		const key = await keyFor(admin.id, "destructive");
		const res = await withKey(
			key.secret,
			"POST",
			"/admin/invitations",
			invite("instructor", 4),
		);
		expect(res.statusCode).toBe(201);
	});
});

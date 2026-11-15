import { createApiKey, createOidcClient, precreateDexAccount } from "@portikus/auth";
import {
	base32Decode,
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	SoftPasskey,
	startMockOidcProvider,
	totpCode,
	totpStep,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { toAuthOptions } from "../auth-options.js";
import type { Operation } from "../catalog/index.js";
import { buildServer } from "../server.js";
import { stubDex } from "../testing/stub-dex.js";
import { MATRIX_MOCK_USERS, PUBLIC_URL, testConfig } from "../testing/test-support.js";

/**
 * API key management (SPEC.md sections 24.8, 24.11 and 24.13): staff make,
 * renew and revoke their own keys; a Dex local-password account proves its
 * second factor to make one; an expired key renews with the same secret, a
 * revoked one never; administrators expire or revoke one key, one person's or
 * every key; disabling a person or resetting their credentials revokes theirs.
 */

/** A read record, so a key has something to prove it works with. */
vi.mock("../catalog/index.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../catalog/index.js")>();
	const settings: Operation = {
		name: "people.my_settings",
		description: "A test record.",
		risk: "read",
		audience: "staff",
		tool: false,
		input: { query: z.unknown() },
	};
	return {
		...real,
		operationByKey: (key: string) =>
			key === "GET /me/settings" ? settings : real.operationByKey(key),
	};
});

const skip = !hasTestDb();

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let stub: ReturnType<typeof stubDex>;

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
	stub = stubDex();
	const config = testConfig(mock.issuer);
	app = buildServer({
		db: testDb.db,
		config,
		logger: collectingLogger("debug").logger,
		oidc: createOidcClient(toAuthOptions(config)),
		dex: stub.dex,
		previewPollIntervalMs: 50,
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

function get(jar: CookieJar, url: string) {
	return app.inject({ method: "GET", url, headers: { cookie: jar.cookieHeader() } });
}

function post(jar: CookieJar, url: string, payload: object = {}) {
	return app.inject({
		method: "POST",
		url,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload,
	});
}

/** Whether a key works: 200 on a read it may run, 401 when it no longer signs in. */
async function keyStatus(secret: string): Promise<number> {
	const res = await app.inject({
		method: "GET",
		url: "/me/settings",
		headers: { authorization: `Bearer ${secret}` },
	});
	return res.statusCode;
}

async function makeKey(userId: string, name = "Laptop") {
	const made = await createApiKey(testDb.db, userId, {
		name,
		scope: "read",
		periodDays: 30,
	});
	if (!made.ok) throw new Error(made.reason);
	return { id: made.key.id, secret: made.secret };
}

async function auditRows(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.select(["actor", "target", "metadata"])
		.where("action", "=", action)
		.orderBy("id")
		.execute();
}

async function notices(userId: string) {
	return testDb.db
		.selectFrom("notifications")
		.select(["title", "body"])
		.where("user_id", "=", userId)
		.execute();
}

const OWNER_ROUTES = (id: string) => [
	["GET", "/me/api-keys"],
	["POST", "/me/api-keys"],
	["POST", "/me/api-keys/passkey/start"],
	["POST", `/me/api-keys/${id}/renew`],
	["POST", `/me/api-keys/${id}/rotate`],
	["POST", `/me/api-keys/${id}/revoke`],
];

describe.skipIf(skip)("who may hold a key", () => {
	test("a student gets 403 on every key route and cannot create a key", async () => {
		const alice = await signIn("alice");
		for (const [method, url] of OWNER_ROUTES(crypto.randomUUID())) {
			const res =
				method === "GET"
					? await get(alice.jar, url as string)
					: await post(alice.jar, url as string, { name: "Mine" });
			expect(res.statusCode, `${method} ${url}`).toBe(403);
		}
		expect(await testDb.db.selectFrom("api_keys").selectAll().execute()).toEqual([]);
	});

	test("an instructor from SSO makes a key with no extra check, 30 days only", async () => {
		const ivy = await signIn("ivy");
		const list = await get(ivy.jar, "/me/api-keys");
		expect(list.json()).toEqual({ keys: [], periods: [30] });
		expect(
			(await post(ivy.jar, "/me/api-keys", { name: "Long", periodDays: 90 }))
				.statusCode,
		).toBe(400);

		const made = await post(ivy.jar, "/me/api-keys", {
			name: "Laptop",
			scope: "write",
		});
		expect(made.statusCode).toBe(201);
		expect(made.headers["cache-control"]).toBe("no-store");
		const { key, secret } = made.json();
		expect(secret).toMatch(/^portikus_/);
		expect(key).toMatchObject({
			name: "Laptop",
			scope: "write",
			periodDays: 30,
			state: "active",
		});
		expect(await keyStatus(secret)).toBe(200);

		// The list never carries the secret again.
		const after = await get(ivy.jar, "/me/api-keys");
		expect(after.body).not.toContain(secret);
		expect(after.json().keys).toHaveLength(1);
		expect(await auditRows("api_key.created")).toEqual([
			expect.objectContaining({
				actor: `user:${ivy.id}`,
				target: ivy.id,
				metadata: expect.objectContaining({ keyId: key.id, scope: "write" }),
			}),
		]);
	});

	test("a key cannot manage keys, even its own", async () => {
		const carol = await signIn("carol");
		const key = await makeKey(carol.id);
		const res = await app.inject({
			method: "POST",
			url: `/me/api-keys/${key.id}/renew`,
			headers: { authorization: `Bearer ${key.secret}` },
		});
		expect(res.statusCode).toBe(403);
		expect(res.json().code).toBe("NOT_AVAILABLE_TO_API_KEYS");
	});
});

describe.skipIf(skip)("a Dex local-password account proves its second factor", () => {
	async function localAdmin() {
		const { jar, id } = await signIn("admin");
		const start = await post(jar, "/me/second-factor/totp/start");
		const secret = base32Decode(start.json().secret);
		const done = await post(jar, "/me/second-factor/totp", {
			token: start.json().token,
			code: totpCode(secret, totpStep(Date.now())),
			label: "Phone",
		});
		expect(done.statusCode).toBe(200);
		await testDb.db
			.updateTable("users")
			.set({ role: "administrator", granted_role: "administrator" })
			.where("id", "=", id)
			.execute();
		return { jar, codes: done.json().recoveryCodes as string[] };
	}

	test("with no code it is refused; a wrong code is refused; a recovery code makes the key", async () => {
		const { jar, codes } = await localAdmin();
		const listed = await get(jar, "/me/api-keys");
		expect(listed.statusCode, listed.body).toBe(200);
		const periods = listed.json().periods;
		expect(periods).toEqual([7, 30, 90, null]);

		const none = await post(jar, "/me/api-keys", { name: "Laptop" });
		expect(none.statusCode).toBe(403);
		expect(none.json().code).toBe("SECOND_FACTOR_REQUIRED");
		const wrong = await post(jar, "/me/api-keys", { name: "Laptop", code: "000000" });
		expect(wrong.statusCode).toBe(403);
		expect(wrong.json().code).toBe("WRONG_CODE");
		// The refusal never quotes the code back.
		expect(wrong.body).not.toContain("000000");

		const made = await post(jar, "/me/api-keys", {
			name: "Laptop",
			periodDays: null,
			code: codes[0],
		});
		expect(made.statusCode).toBe(201);
		expect(made.json().key).toMatchObject({ periodDays: null, expiresAt: null });
		const verified = await auditRows("auth.second_factor_verified");
		expect(verified.at(-1)?.metadata).toMatchObject({ flow: "api_key" });
	});

	test("a passkey answers the create dialog's own challenge", async () => {
		const { jar } = await localAdmin();
		const key = new SoftPasskey(PUBLIC_URL);
		const reg = await post(jar, "/me/second-factor/webauthn/start");
		expect(
			(
				await post(jar, "/me/second-factor/webauthn", {
					credential: key.register(reg.json()),
					label: "Laptop",
				})
			).statusCode,
		).toBe(200);

		const start = await post(jar, "/me/api-keys/passkey/start");
		expect(start.statusCode).toBe(200);
		const made = await post(jar, "/me/api-keys", {
			name: "Laptop",
			credential: key.authenticate(start.json()),
		});
		expect(made.statusCode).toBe(201);
	});

	test("an SSO account is offered no passkey challenge", async () => {
		const carol = await signIn("carol");
		const res = await post(carol.jar, "/me/api-keys/passkey/start");
		expect(res.statusCode).toBe(400);
	});
});

describe.skipIf(skip)("renewal and revocation by the owner", () => {
	test("an expired key renewed by its owner works again with the same secret", async () => {
		const ivy = await signIn("ivy");
		const carol = await signIn("carol");
		const key = await makeKey(ivy.id);
		const expired = await post(carol.jar, `/admin/api-keys/${key.id}/expire`);
		expect(expired.json()).toEqual({ affected: 1 });
		expect(await auditRows("api_key.expired")).toHaveLength(1);
		expect(await keyStatus(key.secret)).toBe(401);
		expect(await notices(ivy.id)).toEqual([
			expect.objectContaining({ title: "An administrator expired your API key" }),
		]);

		const renewed = await post(ivy.jar, `/me/api-keys/${key.id}/renew`);
		expect(renewed.statusCode).toBe(200);
		expect(renewed.json()).toMatchObject({ id: key.id, state: "active" });
		expect(renewed.body).not.toContain(key.secret);
		expect(await keyStatus(key.secret)).toBe(200);
		expect(await auditRows("api_key.renewed")).toHaveLength(1);
	});

	test("renewing with a new secret retires the old one and shows the new one once", async () => {
		const ivy = await signIn("ivy");
		const key = await makeKey(ivy.id);
		const rotated = await post(ivy.jar, `/me/api-keys/${key.id}/rotate`);
		expect(rotated.statusCode).toBe(200);
		expect(rotated.headers["cache-control"]).toBe("no-store");
		const { secret } = rotated.json();
		expect(secret).not.toBe(key.secret);
		expect(await keyStatus(key.secret)).toBe(401);
		expect(await keyStatus(secret)).toBe(200);
		expect(await auditRows("api_key.rotated")).toHaveLength(1);
	});

	test("a revoked key cannot be renewed, with or without a new secret", async () => {
		const ivy = await signIn("ivy");
		const key = await makeKey(ivy.id);
		expect((await post(ivy.jar, `/me/api-keys/${key.id}/revoke`)).json()).toEqual({
			affected: 1,
		});
		expect(await keyStatus(key.secret)).toBe(401);
		for (const verb of ["renew", "rotate"]) {
			const res = await post(ivy.jar, `/me/api-keys/${key.id}/${verb}`);
			expect(res.statusCode, verb).toBe(409);
			expect(res.json().code).toBe("API_KEY_REVOKED");
		}
		// The owner revoking their own key gets no notice about it.
		expect(await notices(ivy.id)).toEqual([]);
		expect(await auditRows("api_key.revoked")).toEqual([
			expect.objectContaining({ actor: `user:${ivy.id}`, target: ivy.id }),
		]);
	});

	test("an owner cannot renew or revoke someone else's key", async () => {
		const ivy = await signIn("ivy");
		const carol = await signIn("carol");
		const key = await makeKey(carol.id);
		for (const verb of ["renew", "rotate", "revoke"]) {
			const res = await post(ivy.jar, `/me/api-keys/${key.id}/${verb}`);
			expect(res.statusCode, verb).toBe(404);
		}
		expect(await keyStatus(key.secret)).toBe(200);
	});

	test("an owner who is no longer staff cannot renew", async () => {
		const ivy = await signIn("ivy");
		const key = await makeKey(ivy.id);
		await testDb.db
			.updateTable("users")
			.set({ role: "student" })
			.where("id", "=", ivy.id)
			.execute();
		expect((await post(ivy.jar, `/me/api-keys/${key.id}/renew`)).statusCode).toBe(403);
	});
});

describe.skipIf(skip)("administrators", () => {
	test("list every key or one person's, and revoke one person's keys", async () => {
		const carol = await signIn("carol");
		const ivy = await signIn("ivy");
		await makeKey(ivy.id, "One");
		const two = await makeKey(ivy.id, "Two");
		await makeKey(carol.id, "Carol's");
		expect((await get(carol.jar, "/admin/api-keys")).json().keys).toHaveLength(3);
		const ivys = (await get(carol.jar, `/admin/api-keys?userId=${ivy.id}`)).json().keys;
		expect(ivys.map((k: { name: string }) => k.name).sort()).toEqual(["One", "Two"]);
		expect((await get(ivy.jar, "/admin/api-keys")).statusCode).toBe(403);

		const res = await post(carol.jar, `/admin/users/${ivy.id}/api-keys/revoke`);
		expect(res.json()).toEqual({ affected: 2 });
		expect(await keyStatus(two.secret)).toBe(401);
		// One row per key, one notice for the owner.
		expect(await auditRows("api_key.revoked")).toHaveLength(2);
		expect(await notices(ivy.id)).toEqual([
			{
				title: "An administrator revoked your API key",
				body: expect.stringContaining("2 of your API keys"),
			},
		]);
	});

	test("expire every key on the site, then revoke every key", async () => {
		const carol = await signIn("carol");
		const ivy = await signIn("ivy");
		const a = await makeKey(ivy.id);
		const b = await makeKey(carol.id);
		expect((await post(carol.jar, "/admin/api-keys/expire-all")).json()).toEqual({
			affected: 2,
		});
		expect(await keyStatus(a.secret)).toBe(401);
		expect(await keyStatus(b.secret)).toBe(401);
		// The administrator's own key changed too, but nobody notifies them of their own act.
		expect(await notices(carol.id)).toEqual([]);
		expect((await post(carol.jar, "/admin/api-keys/revoke-all")).json()).toEqual({
			affected: 2,
		});
		expect((await post(ivy.jar, `/me/api-keys/${a.id}/renew`)).statusCode).toBe(409);
	});

	test("expiring or revoking a key that does not exist is a 404", async () => {
		const carol = await signIn("carol");
		for (const verb of ["expire", "revoke"]) {
			const res = await post(
				carol.jar,
				`/admin/api-keys/${crypto.randomUUID()}/${verb}`,
			);
			expect(res.statusCode, verb).toBe(404);
		}
	});

	test("disabling a person revokes their keys, audited", async () => {
		const carol = await signIn("carol");
		const ivy = await signIn("ivy");
		const key = await makeKey(ivy.id);
		expect((await post(carol.jar, `/admin/users/${ivy.id}/disable`)).statusCode).toBe(
			200,
		);
		await testDb.db
			.updateTable("users")
			.set({ disabled_at: null })
			.where("id", "=", ivy.id)
			.execute();
		// Enabling the person again does not bring the key back.
		expect(await keyStatus(key.secret)).toBe(401);
		expect(await auditRows("api_key.revoked")).toEqual([
			expect.objectContaining({
				actor: `user:${carol.id}`,
				target: ivy.id,
				metadata: expect.objectContaining({ keyId: key.id, reason: "user_disabled" }),
			}),
		]);
	});

	test.each([
		["reset-password", "password_reset"],
		["reset-second-factor", "second_factor_reset"],
		["remove", "user_disabled"],
	])("an administrator's %s revokes the person's keys", async (action, reason) => {
		const carol = await signIn("carol");
		const id = await precreateDexAccount(testDb.db, {
			userId: "dex-dana",
			email: "dana@example.edu",
			username: "dana",
			displayName: "Dana",
			role: "administrator",
		});
		stub.passwords.set("dana@example.edu", {
			email: "dana@example.edu",
			username: "dana",
			userId: "dex-dana",
			hash: "h",
		});
		const key = await makeKey(id);
		const res = await post(carol.jar, `/admin/dex-users/${id}/${action}`);
		expect(res.statusCode, res.body).toBe(200);
		const row = await testDb.db
			.selectFrom("api_keys")
			.select("revoked_at")
			.where("id", "=", key.id)
			.executeTakeFirstOrThrow();
		expect(row.revoked_at).not.toBeNull();
		expect(await auditRows("api_key.revoked")).toEqual([
			expect.objectContaining({ metadata: expect.objectContaining({ reason }) }),
		]);
	});
});

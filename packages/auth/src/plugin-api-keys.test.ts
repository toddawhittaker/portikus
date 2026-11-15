import { type Database, recordAudit } from "@portikus/db";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import Fastify, { type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createApiKey, expireApiKeys, revokeApiKeys } from "./api-keys.js";
import { type ApiKeyHooks, authPlugin } from "./plugin.js";
import { createSession, upsertUser } from "./sessions.js";
import { type AuthOptions, SESSION_COOKIE } from "./types.js";

/** Key sign-in in the auth plugin (SPEC.md sections 24.8, 24.11 and 24.13). */

const PUBLIC_URL = "http://127.0.0.1:5173";

const auth: AuthOptions = {
	publicUrl: PUBLIC_URL,
	issuerUrl: "http://127.0.0.1:3002",
	clientId: "portikus-dev",
	clientSecret: "portikus-dev-secret",
	scopes: "openid profile email",
	groupsClaim: "groups",
	studentGroup: "portikus-students",
	adminGroup: "portikus-administrators",
	instructorGroup: "portikus-instructors",
	cookieSecret: "a-test-cookie-secret-value",
	sessionTtlSeconds: 3600,
};

describe("without an API key gate", () => {
	test("every key request is refused with 403 and no lookup, so a missing gate fails closed", async () => {
		const db = {} as Kysely<Database>;
		const app = Fastify();
		await app.register(authPlugin, { db, auth });
		app.get("/health", async () => "ok");
		app.get("/anything", async () => "ok");
		for (const url of ["/health", "/anything"]) {
			const res = await app.inject({
				method: "GET",
				url,
				headers: { authorization: "Bearer portikus_anything" },
			});
			expect(res.statusCode).toBe(403);
			expect(res.json().code).toBe("NOT_AVAILABLE_TO_API_KEYS");
		}
		await app.close();
	});
});

describe.skipIf(!hasTestDb())("API keys in the auth plugin", () => {
	let t: TestDb;
	let app: FastifyInstance;
	const authorize = vi.fn<ApiKeyHooks["authorize"]>(async () => true);
	const beforeLookup = vi.fn<NonNullable<ApiKeyHooks["beforeLookup"]>>(
		async () => true,
	);
	const unknownKey = vi.fn<NonNullable<ApiKeyHooks["unknownKey"]>>(async () => true);

	beforeAll(async () => {
		t = await createTestDb();
		app = Fastify({ logger: false });
		await app.register(authPlugin, {
			db: t.db,
			auth,
			apiKeys: { authorize, beforeLookup, unknownKey },
		});
		app.get("/who", async (request) => ({
			user: request.user,
			apiKey: request.apiKey,
			sessionToken: request.sessionToken,
		}));
		app.post("/audited", async (request) => {
			await recordAudit(t.db, {
				actor: `user:${request.user?.id}`,
				target: "t",
				action: "test.write",
				result: "ok",
			});
			return { ok: true };
		});
		app.post("/me/password", async () => ({ ok: true }));
		await app.ready();
	});

	afterAll(async () => {
		await app?.close();
		await t?.close();
	});

	beforeEach(async () => {
		await t.truncate();
		authorize.mockReset().mockResolvedValue(true);
		beforeLookup.mockReset().mockResolvedValue(true);
		unknownKey.mockReset().mockResolvedValue(true);
	});

	async function keyFor(role = "instructor", scope: "read" | "write" = "read") {
		const userId = await insertTestUser(t.db, { role });
		const made = await createApiKey(t.db, userId, { name: "k", scope, periodDays: 30 });
		if (!made.ok) throw new Error(made.reason);
		return { userId, keyId: made.key.id, secret: made.secret };
	}

	const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

	async function sessionToken(): Promise<string> {
		const user = await upsertUser(
			t.db,
			{
				issuer: "https://idp.example.edu",
				subject: "session-user",
				email: null,
				displayName: "Session User",
				preferredUsername: "session-user",
			},
			"administrator",
		);
		return (
			await createSession(t.db, user.id, 3600, { method: "oidc", courseUserId: null })
		).token;
	}

	test("a key identifies its owner, with no session and no second factor owed", async () => {
		const { userId, keyId, secret } = await keyFor("administrator", "write");
		const res = await app.inject({
			method: "GET",
			url: "/who",
			headers: bearer(secret),
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({
			user: { id: userId, role: "administrator", secondFactor: null },
			apiKey: { id: keyId, scope: "write" },
			sessionToken: null,
		});
	});

	test("a session request has no key", async () => {
		const token = await sessionToken();
		const res = await app.inject({
			method: "GET",
			url: "/who",
			headers: { cookie: `${SESSION_COOKIE}=${token}` },
		});
		expect(res.json().apiKey).toBeNull();
		expect(authorize).not.toHaveBeenCalled();
	});

	test("a key request skips the origin check a cookie POST needs", async () => {
		const { secret } = await keyFor();
		for (const extra of [{}, { origin: "https://evil.example.com" }]) {
			const res = await app.inject({
				method: "POST",
				url: "/audited",
				headers: { ...bearer(secret), ...extra },
			});
			expect(res.statusCode).toBe(200);
		}
	});

	test("the cookie is ignored when a key is present: a bad key is 401 even with a good session", async () => {
		const token = await sessionToken();
		const res = await app.inject({
			method: "GET",
			url: "/who",
			headers: { cookie: `${SESSION_COOKIE}=${token}`, ...bearer("portikus_wrong") },
		});
		expect(res.statusCode).toBe(401);
	});

	test("a good key wins over another person's session cookie", async () => {
		const token = await sessionToken();
		const { userId, secret } = await keyFor();
		const res = await app.inject({
			method: "GET",
			url: "/who",
			headers: { cookie: `${SESSION_COOKIE}=${token}`, ...bearer(secret) },
		});
		expect(res.json().user.id).toBe(userId);
		expect(res.json().sessionToken).toBeNull();
	});

	test("a Bearer value that is not a key leaves the cookie path alone", async () => {
		const token = await sessionToken();
		const res = await app.inject({
			method: "GET",
			url: "/who",
			headers: { cookie: `${SESSION_COOKIE}=${token}`, authorization: "Bearer other" },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().apiKey).toBeNull();
		expect(authorize).not.toHaveBeenCalled();
	});

	test("unknown, revoked, expired, disabled and student-owned keys all get the same 401", async () => {
		const unknown = "portikus_unknown";
		const revoked = await keyFor();
		await revokeApiKeys(t.db, { keyId: revoked.keyId }, revoked.userId);
		const expired = await keyFor();
		await expireApiKeys(t.db, { keyId: expired.keyId }, new Date(Date.now() - 1000));
		const disabled = await keyFor();
		await t.db
			.updateTable("users")
			.set({ disabled_at: new Date().toISOString() })
			.where("id", "=", disabled.userId)
			.execute();
		const student = await keyFor();
		await t.db
			.updateTable("users")
			.set({ role: "student" })
			.where("id", "=", student.userId)
			.execute();
		const bodies = new Set<string>();
		for (const secret of [
			unknown,
			revoked.secret,
			expired.secret,
			disabled.secret,
			student.secret,
		]) {
			const res = await app.inject({
				method: "GET",
				url: "/who",
				headers: bearer(secret),
			});
			expect(res.statusCode).toBe(401);
			expect(res.headers["www-authenticate"]).toBe("Bearer");
			bodies.add(res.body);
		}
		expect(bodies.size).toBe(1);
		expect(authorize).not.toHaveBeenCalled();
	});

	test("the lookup hooks see the secret, and an unknown key can be answered by its hook", async () => {
		unknownKey.mockImplementation(async (_request, reply) => {
			await reply.code(429).send({ code: "RATE_LIMITED", message: "slow down" });
			return false;
		});
		const res = await app.inject({
			method: "GET",
			url: "/who",
			headers: bearer("portikus_unknown"),
		});
		expect(res.statusCode).toBe(429);
		expect(beforeLookup.mock.calls[0]?.[2]).toBe("portikus_unknown");
		expect(unknownKey.mock.calls[0]?.[2]).toBe("portikus_unknown");

		const { secret } = await keyFor();
		unknownKey.mockClear();
		await app.inject({ method: "GET", url: "/who", headers: bearer(secret) });
		expect(unknownKey).not.toHaveBeenCalled();
	});

	test("a beforeLookup refusal ends the request before any lookup", async () => {
		beforeLookup.mockImplementation(async (_request, reply) => {
			await reply.code(429).send({ code: "RATE_LIMITED", message: "slow down" });
			return false;
		});
		const { secret } = await keyFor();
		const res = await app.inject({
			method: "GET",
			url: "/who",
			headers: bearer(secret),
		});
		expect(res.statusCode).toBe(429);
		expect(authorize).not.toHaveBeenCalled();
	});

	test("authorize runs after resolution with the key set, and its refusal ends the request", async () => {
		const { keyId, secret } = await keyFor();
		authorize.mockImplementation(async (request, reply) => {
			expect(request.apiKey?.id).toBe(keyId);
			expect(request.user?.role).toBe("instructor");
			await reply.code(403).send({ code: "SCOPE_REQUIRED", message: "no" });
			return false;
		});
		const res = await app.inject({
			method: "POST",
			url: "/audited",
			headers: bearer(secret),
		});
		expect(res.statusCode).toBe(403);
		expect(res.json().code).toBe("SCOPE_REQUIRED");
		const rows = await t.db.selectFrom("audit_events").select("id").execute();
		expect(rows).toEqual([]);
	});

	test("a WebSocket upgrade is refused to a key without reaching authorize", async () => {
		const { secret } = await keyFor();
		const res = await app.inject({
			method: "GET",
			url: "/who",
			headers: { ...bearer(secret), upgrade: "websocket", origin: PUBLIC_URL },
		});
		expect(res.statusCode).toBe(403);
		expect(authorize).not.toHaveBeenCalled();
	});

	test("the gates still hold a key's owner: a forced password change and the acceptable-use statement", async () => {
		const { userId, secret } = await keyFor();
		await t.db
			.updateTable("users")
			.set({ must_change_password: true })
			.where("id", "=", userId)
			.execute();
		const held = await app.inject({
			method: "GET",
			url: "/who",
			headers: bearer(secret),
		});
		expect(held.statusCode).toBe(403);
		expect(held.json().code).toBe("PASSWORD_CHANGE_REQUIRED");
		const allowed = await app.inject({
			method: "POST",
			url: "/me/password",
			headers: bearer(secret),
		});
		expect(allowed.statusCode).toBe(200);

		await t.db
			.updateTable("users")
			.set({ must_change_password: false, acceptable_use_version: 0 })
			.where("id", "=", userId)
			.execute();
		const unaccepted = await app.inject({
			method: "GET",
			url: "/who",
			headers: bearer(secret),
		});
		expect(unaccepted.json().code).toBe("ACCEPTABLE_USE_REQUIRED");
	});

	describe("audit arrival (SPEC.md section 24.11)", () => {
		const rows = () =>
			t.db.selectFrom("audit_events").select(["action", "via", "api_key_id"]).execute();

		test("a row written in a POST handler by a key carries via api_key and the key", async () => {
			const { keyId, secret } = await keyFor("instructor", "write");
			const res = await app.inject({
				method: "POST",
				url: "/audited",
				headers: bearer(secret),
				payload: { a: 1 },
			});
			expect(res.statusCode).toBe(200);
			expect(await rows()).toEqual([
				{ action: "test.write", via: "api_key", api_key_id: keyId },
			]);
		});

		test("a row written by a signed-in browser carries via session and no key", async () => {
			const token = await sessionToken();
			await app.inject({
				method: "POST",
				url: "/audited",
				headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: PUBLIC_URL },
			});
			expect(await rows()).toEqual([
				{ action: "test.write", via: "session", api_key_id: null },
			]);
		});

		test("requests do not leak their arrival into one another", async () => {
			const { keyId, secret } = await keyFor("instructor", "write");
			const token = await sessionToken();
			await Promise.all([
				app.inject({ method: "POST", url: "/audited", headers: bearer(secret) }),
				app.inject({
					method: "POST",
					url: "/audited",
					headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: PUBLIC_URL },
				}),
			]);
			expect((await rows()).map((r) => [r.via, r.api_key_id]).sort()).toEqual([
				["api_key", keyId],
				["session", null],
			]);
		});

		test("it holds over a real connection with a request body", async () => {
			const { keyId, secret } = await keyFor("instructor", "write");
			const address = await app.listen({ port: 0, host: "127.0.0.1" });
			const res = await fetch(`${address}/audited`, {
				method: "POST",
				headers: { ...bearer(secret), "content-type": "application/json" },
				body: JSON.stringify({ a: 1 }),
			});
			expect(res.status).toBe(200);
			expect(await rows()).toEqual([
				{ action: "test.write", via: "api_key", api_key_id: keyId },
			]);
		});
	});
});

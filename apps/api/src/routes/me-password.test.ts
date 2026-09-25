import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDexApi,
	createOidcClient,
	createSession,
	type DexApi,
	dexLocalSubject,
	hashDexPassword,
	hashSessionToken,
} from "@portikus/auth";
import {
	CookieJar,
	csrfHeaders,
	type DexGrpcCerts,
	type FakeDexGrpc,
	loginAs,
	type MockOidcProvider,
	startFakeDexGrpc,
	startMockOidcProvider,
	writeDexGrpcCerts,
} from "@portikus/auth/testing";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiUser,
	type TestDb,
} from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { toAuthOptions } from "../auth-options.js";
import { buildServer } from "../server.js";
import { buildTestServer, PUBLIC_URL, testConfig } from "../test-support.js";

/**
 * Settings, Password and the "must change password" gate
 * (SPEC.md sections 5.1 and 5.3),
 * against the fake Dex gRPC server, so the current password is checked by a
 * real bcrypt comparison.
 */

const skip = !hasTestDb();
const CURRENT = "the-current-password";
const NEW = "a-brand-new-long-password";

let testDb: TestDb;
let mock: MockOidcProvider;
let dir: string;
let certs: DexGrpcCerts;
let fake: FakeDexGrpc;
let dex: DexApi;
let app: FastifyInstance;
let lines: Record<string, unknown>[];

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ redirectUris: [`${PUBLIC_URL}/auth/callback`] });
	dir = mkdtempSync(join(tmpdir(), "me-password-test-"));
	certs = writeDexGrpcCerts(dir);
	fake = await startFakeDexGrpc(certs);
	dex = createDexApi({
		address: fake.address,
		ca: readFileSync(certs.ca),
		cert: readFileSync(certs.clientCert),
		key: readFileSync(certs.clientKey),
	});
});

afterAll(async () => {
	if (skip) return;
	dex.close();
	await fake.close();
	rmSync(dir, { recursive: true, force: true });
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	fake.passwords.clear();
	const collected = collectingLogger("debug");
	lines = collected.lines;
	const config = testConfig(mock.issuer);
	app = buildServer({
		db: testDb.db,
		config,
		logger: collected.logger,
		oidc: createOidcClient(toAuthOptions(config)),
		dex,
		previewPollIntervalMs: 50,
	});
	await app.ready();
	return async () => {
		await app.close();
	};
});

/**
 * Sign a mock user in, then turn the account into a Dex local password with
 * `password`, as if Dex had signed them in. Returns its id.
 */
async function localAccount(
	sub: string,
	jar: CookieJar,
	password = CURRENT,
): Promise<string> {
	await loginAs(app, sub, jar);
	const dexUserId = crypto.randomUUID();
	const row = await testDb.db
		.updateTable("users")
		.set({ oidc_subject: dexLocalSubject(dexUserId) })
		.where("oidc_subject", "=", sub)
		.returning("id")
		.executeTakeFirstOrThrow();
	await dex.createPassword({
		email: `${sub}@example.edu`,
		username: sub,
		userId: dexUserId,
		hash: await hashDexPassword(password),
	});
	return row.id;
}

function change(jar: CookieJar, body: object, headers: Record<string, string> = {}) {
	return app.inject({
		method: "POST",
		url: "/me/password",
		headers: { ...csrfHeaders(jar, PUBLIC_URL), ...headers },
		payload: body,
	});
}

function storedHash(email: string): string {
	return fake.passwords.get(email)?.hash.toString("utf8") ?? "";
}

async function auditRows(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.select(["actor", "target", "result", "metadata"])
		.where("action", "=", action)
		.orderBy("id")
		.execute();
}

async function flagOf(id: string): Promise<boolean> {
	const row = await testDb.db
		.selectFrom("users")
		.select("must_change_password")
		.where("id", "=", id)
		.executeTakeFirstOrThrow();
	return row.must_change_password;
}

/** A preview session hanging off the given main session. */
async function previewFor(userId: string, sessionId: string): Promise<string> {
	const workspaceId = crypto.randomUUID();
	// One workspace per account: reuse it for a second preview session.
	const existing = await testDb.db
		.selectFrom("workspaces")
		.select("id")
		.where("owner_user_id", "=", userId)
		.executeTakeFirst();
	if (!existing) {
		await testDb.db
			.insertInto("workspaces")
			.values({
				id: workspaceId,
				owner_user_id: userId,
				incus_instance_name: `ws-${workspaceId.slice(0, 8)}`,
				label: `pw-${workspaceId.slice(0, 8)}`,
				state: "stopped",
				desired_state: "stopped",
			})
			.execute();
	}
	const row = await testDb.db
		.insertInto("preview_sessions")
		.values({
			token_hash: `hash-${crypto.randomUUID()}`,
			user_id: userId,
			session_id: sessionId,
			workspace_id: existing?.id ?? workspaceId,
			port: 3000,
			preview_host: "x.preview.localhost",
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

/** Revoked, or gone with its main session. */
async function revoked(previewId: string): Promise<boolean> {
	const row = await testDb.db
		.selectFrom("preview_sessions")
		.select("revoked_at")
		.where("id", "=", previewId)
		.executeTakeFirst();
	return !row || row.revoked_at !== null;
}

describe.skipIf(skip)("POST /me/password", () => {
	test("changes the Dex hash, clears the flag, and ends only the other sessions", async () => {
		const jar = new CookieJar();
		const id = await localAccount("alice", jar);
		await testDb.db
			.updateTable("users")
			.set({ must_change_password: true })
			.where("id", "=", id)
			.execute();
		const other = await createSession(testDb.db, id, 3600, {
			method: "oidc",
			courseUserId: null,
		});
		const current = hashSessionToken(
			jar.cookieHeader().replace(/^.*portikus_session=([^;]+).*$/, "$1"),
		);
		const otherPreview = await previewFor(id, hashSessionToken(other.token));
		const ownPreview = await previewFor(id, current);
		const bob = new CookieJar();
		const bobId = await localAccount("bob", bob);
		const bobSession = await createSession(testDb.db, bobId, 3600, {
			method: "oidc",
			courseUserId: null,
		});
		const bobHash = storedHash("bob@example.edu");

		const res = await change(jar, { currentPassword: CURRENT, newPassword: NEW });
		expect(res.statusCode).toBe(204);

		const hash = storedHash("alice@example.edu");
		expect(hash).toMatch(/^\$2[aby]\$10\$/);
		expect(await bcrypt.compare(NEW, hash)).toBe(true);
		expect(await bcrypt.compare(CURRENT, hash)).toBe(false);
		expect(await flagOf(id)).toBe(false);

		const sessions = await testDb.db
			.selectFrom("sessions")
			.select("id")
			.where("user_id", "=", id)
			.execute();
		expect(sessions).toEqual([{ id: current }]);
		expect(await revoked(otherPreview)).toBe(true);
		expect(await revoked(ownPreview)).toBe(false);
		const me = await app.inject({
			method: "GET",
			url: "/auth/me",
			headers: { cookie: jar.cookieHeader() },
		});
		expect(me.statusCode).toBe(200);

		// Nobody else's password or sessions moved.
		expect(storedHash("bob@example.edu")).toBe(bobHash);
		const bobSessions = await testDb.db
			.selectFrom("sessions")
			.select("id")
			.where("id", "=", hashSessionToken(bobSession.token))
			.execute();
		expect(bobSessions).toHaveLength(1);

		const audit = await auditRows("user.password_changed");
		expect(audit).toEqual([
			{
				actor: `user:${id}`,
				target: id,
				result: "ok",
				metadata: { ip: expect.any(String), userAgent: expect.any(String) },
			},
		]);
		const everything = JSON.stringify([audit, lines, res.body]);
		for (const secret of [CURRENT, NEW, hash]) {
			expect(everything).not.toContain(secret);
		}
	});

	test("a wrong current password is 403 and changes nothing", async () => {
		const jar = new CookieJar();
		const id = await localAccount("alice", jar);
		await testDb.db
			.updateTable("users")
			.set({ must_change_password: true })
			.where("id", "=", id)
			.execute();
		const before = storedHash("alice@example.edu");
		const res = await change(jar, {
			currentPassword: "not-the-password",
			newPassword: NEW,
		});
		expect(res.statusCode).toBe(403);
		expect(res.json().code).toBe("WRONG_PASSWORD");
		expect(storedHash("alice@example.edu")).toBe(before);
		expect(await flagOf(id)).toBe(true);
		expect(await auditRows("user.password_changed")).toEqual([
			{
				actor: `user:${id}`,
				target: id,
				result: "failed",
				metadata: { ip: expect.any(String), userAgent: expect.any(String) },
			},
		]);
		expect(JSON.stringify(lines)).not.toContain("not-the-password");
	});

	test("ten wrong current passwords per address, then 429, audited once", async () => {
		const jar = new CookieJar();
		await localAccount("alice", jar);
		for (let i = 0; i < 10; i++) {
			const res = await change(jar, {
				currentPassword: `wrong-${i}`,
				newPassword: NEW,
			});
			expect(res.statusCode).toBe(403);
		}
		// Even the right password waits now.
		for (let i = 0; i < 2; i++) {
			const res = await change(jar, { currentPassword: CURRENT, newPassword: NEW });
			expect(res.statusCode).toBe(429);
			expect(res.json().code).toBe("RATE_LIMITED");
		}
		expect(await bcrypt.compare(CURRENT, storedHash("alice@example.edu"))).toBe(true);
		const throttled = await auditRows("auth.throttled");
		expect(throttled).toHaveLength(1);
		expect(throttled[0]?.metadata).toMatchObject({ scope: "password-change" });
	});

	test("a right password does not count against the throttle", async () => {
		const jar = new CookieJar();
		await localAccount("alice", jar);
		let current = CURRENT;
		for (let i = 0; i < 11; i++) {
			const next = `${NEW}-${i}`;
			const res = await change(jar, { currentPassword: current, newPassword: next });
			expect(res.statusCode).toBe(204);
			current = next;
		}
	});

	test("refuses a new password that is too short, over 72 bytes, or unchanged", async () => {
		const jar = new CookieJar();
		await localAccount("alice", jar);
		const before = storedHash("alice@example.edu");
		for (const newPassword of [
			"fourteen-chars",
			// 40 characters, 80 bytes.
			"é".repeat(40),
			CURRENT,
		]) {
			const res = await change(jar, { currentPassword: CURRENT, newPassword });
			expect(res.statusCode, newPassword).toBe(400);
			expect(res.json().code).toBe("VALIDATION_FAILED");
			expect(res.body).not.toContain(newPassword);
		}
		expect((await change(jar, { newPassword: NEW })).statusCode).toBe(400);
		expect(
			(await change(jar, { currentPassword: CURRENT, newPassword: NEW, extra: 1 }))
				.statusCode,
		).toBe(400);
		// Exactly 15 characters is enough.
		expect(
			(await change(jar, { currentPassword: CURRENT, newPassword: "fifteen-chars!!" }))
				.statusCode,
		).toBe(204);
		expect(storedHash("alice@example.edu")).not.toBe(before);
	});

	test("an SSO or upstream-connector account is not a local password", async () => {
		const jar = new CookieJar();
		await loginAs(app, "alice", jar);
		const res = await change(jar, { currentPassword: CURRENT, newPassword: NEW });
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("NOT_LOCAL_PASSWORD");
	});

	test("a local subject Dex holds no password for is not a local password", async () => {
		const jar = new CookieJar();
		await localAccount("alice", jar);
		fake.passwords.clear();
		const res = await change(jar, { currentPassword: CURRENT, newPassword: NEW });
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("NOT_LOCAL_PASSWORD");
	});

	test("a local subject under another issuer is not a local password", async () => {
		const jar = new CookieJar();
		const id = await localAccount("alice", jar);
		await testDb.db
			.updateTable("users")
			.set({ oidc_issuer: "https://elsewhere.example.edu" })
			.where("id", "=", id)
			.execute();
		const res = await change(jar, { currentPassword: CURRENT, newPassword: NEW });
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("NOT_LOCAL_PASSWORD");
	});

	test("a course account is not a local password", async () => {
		const id = await insertTestLtiUser(testDb.db);
		const session = await createSession(testDb.db, id, 3600, {
			method: "lti",
			courseUserId: null,
		});
		const res = await app.inject({
			method: "POST",
			url: "/me/password",
			headers: {
				cookie: `portikus_session=${session.token}`,
				origin: new URL(PUBLIC_URL).origin,
			},
			payload: { currentPassword: CURRENT, newPassword: NEW },
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("NOT_LOCAL_PASSWORD");
	});

	test("needs the CSRF check and a session", async () => {
		const jar = new CookieJar();
		await localAccount("alice", jar);
		const crossSite = await app.inject({
			method: "POST",
			url: "/me/password",
			headers: { cookie: jar.cookieHeader() },
			payload: { currentPassword: CURRENT, newPassword: NEW },
		});
		expect(crossSite.statusCode).toBe(403);
		const anonymous = await app.inject({
			method: "POST",
			url: "/me/password",
			headers: { origin: new URL(PUBLIC_URL).origin },
			payload: { currentPassword: CURRENT, newPassword: NEW },
		});
		expect(anonymous.statusCode).toBe(401);
		expect(await bcrypt.compare(CURRENT, storedHash("alice@example.edu"))).toBe(true);
	});

	test("Dex being down is 503 and changes nothing", async () => {
		const jar = new CookieJar();
		const id = await localAccount("alice", jar);
		await testDb.db
			.updateTable("users")
			.set({ must_change_password: true })
			.where("id", "=", id)
			.execute();
		fake.failing = true;
		try {
			const res = await change(jar, { currentPassword: CURRENT, newPassword: NEW });
			expect(res.statusCode).toBe(503);
		} finally {
			fake.failing = false;
		}
		expect(await flagOf(id)).toBe(true);
		expect(JSON.stringify(lines)).not.toContain(NEW);
	});

	test("answers 404 when the site has no Dex gRPC API", async () => {
		const plain = buildTestServer(testDb.db, mock.issuer);
		await plain.ready();
		try {
			const jar = new CookieJar();
			await loginAs(plain, "alice", jar);
			const res = await plain.inject({
				method: "POST",
				url: "/me/password",
				headers: csrfHeaders(jar, PUBLIC_URL),
				payload: { currentPassword: CURRENT, newPassword: NEW },
			});
			expect(res.statusCode).toBe(404);
		} finally {
			await plain.close();
		}
	});
});

describe.skipIf(skip)("the must-change-password gate", () => {
	async function flagged(): Promise<{ jar: CookieJar; id: string }> {
		const jar = new CookieJar();
		const id = await localAccount("carol", jar);
		await testDb.db
			.updateTable("users")
			.set({ must_change_password: true })
			.where("id", "=", id)
			.execute();
		return { jar, id };
	}

	test("refuses the account's other routes with 403 PASSWORD_CHANGE_REQUIRED", async () => {
		const { jar } = await flagged();
		for (const [method, url] of [
			["GET", `/workspaces/${crypto.randomUUID()}`],
			["POST", "/workspaces"],
			["GET", "/me/settings"],
			["GET", "/admin/users"],
			["GET", "/courses"],
		] as const) {
			const res = await app.inject({
				method,
				url,
				headers: csrfHeaders(jar, PUBLIC_URL),
			});
			expect(res.statusCode, `${method} ${url}`).toBe(403);
			expect(res.json().code).toBe("PASSWORD_CHANGE_REQUIRED");
		}
	});

	test("/auth/me answers with the flag and localPassword, and sign-out works", async () => {
		const { jar } = await flagged();
		const me = await app.inject({
			method: "GET",
			url: "/auth/me",
			headers: { cookie: jar.cookieHeader() },
		});
		expect(me.statusCode).toBe(200);
		expect(me.json()).toMatchObject({
			role: "administrator",
			mustChangePassword: true,
			localPassword: true,
		});
		const out = await app.inject({
			method: "POST",
			url: "/auth/logout",
			headers: csrfHeaders(jar, PUBLIC_URL),
		});
		expect(out.statusCode).toBeLessThan(400);
	});

	test("an SSO account's /auth/me says it has no local password", async () => {
		const jar = new CookieJar();
		await loginAs(app, "alice", jar);
		const me = await app.inject({
			method: "GET",
			url: "/auth/me",
			headers: { cookie: jar.cookieHeader() },
		});
		expect(me.json()).toMatchObject({
			mustChangePassword: false,
			localPassword: false,
		});
	});

	test("refuses a WebSocket upgrade", async () => {
		const { jar } = await flagged();
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
		expect(res.json().code).toBe("PASSWORD_CHANGE_REQUIRED");
	});

	test("lifts once the password is changed", async () => {
		const { jar } = await flagged();
		const res = await change(jar, { currentPassword: CURRENT, newPassword: NEW });
		expect(res.statusCode).toBe(204);
		const settings = await app.inject({
			method: "GET",
			url: "/me/settings",
			headers: { cookie: jar.cookieHeader() },
		});
		expect(settings.statusCode).toBe(200);
	});
});

describe.skipIf(skip)("the setup code is gone", () => {
	test("/setup, /setup/state, /setup/claim and /setup/first-account answer 404", async () => {
		const jar = new CookieJar();
		await loginAs(app, "alice", jar);
		for (const [method, url] of [
			["GET", "/setup"],
			["GET", "/setup/state"],
			["POST", "/setup/claim"],
			["POST", "/setup/first-account"],
		] as const) {
			const res = await app.inject({
				method,
				url,
				headers: csrfHeaders(jar, PUBLIC_URL),
				...(method === "POST" ? { payload: {} } : {}),
			});
			expect(res.statusCode, `${method} ${url}`).toBe(404);
		}
	});
});

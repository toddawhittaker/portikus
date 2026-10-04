import {
	base32Decode,
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
	totpCode,
	totpStep,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

/**
 * Two-step sign-in for Dex local passwords (SPEC.md section 24.13). The mock
 * provider's "admin" user carries a Dex local-password subject, so its
 * sign-in goes through the real callback; "alice" signs in through another
 * provider and is never asked.
 */

const skip = !hasTestDb();

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let lines: Record<string, unknown>[];

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
	const collected = collectingLogger("debug");
	lines = collected.lines;
	app = buildTestServer(testDb.db, mock.issuer, {}, collected.logger);
	await app.ready();
	return async () => {
		await app.close();
	};
});

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

async function signIn(user: string): Promise<CookieJar> {
	const jar = new CookieJar();
	await loginAs(app, user, jar);
	return jar;
}

/** Enrol an authenticator, returning its secret and the recovery codes. */
async function enrol(jar: CookieJar): Promise<{ secret: Buffer; codes: string[] }> {
	const start = await post(jar, "/me/second-factor/totp/start");
	expect(start.statusCode).toBe(200);
	const { token, secret: text } = start.json();
	const secret = base32Decode(text);
	const step = totpStep(Date.now());
	const done = await post(jar, "/me/second-factor/totp", {
		token,
		code: totpCode(secret, step),
		label: "Phone",
	});
	expect(done.statusCode).toBe(200);
	return { secret, codes: done.json().recoveryCodes };
}

async function auditActions(): Promise<string[]> {
	const rows = await testDb.db
		.selectFrom("audit_events")
		.select("action")
		.where("action", "like", "auth.second_factor%")
		.orderBy("id")
		.execute();
	return rows.map((r) => r.action);
}

describe.skipIf(skip)("the second-factor gate", () => {
	test("a local-password account must enrol before anything else", async () => {
		const jar = await signIn("admin");
		expect((await get(jar, "/auth/me")).json()).toMatchObject({
			secondFactor: "enrol",
		});
		const blocked = await get(jar, "/me/settings");
		expect(blocked.statusCode).toBe(403);
		expect(blocked.json().code).toBe("SECOND_FACTOR_REQUIRED");
		expect((await get(jar, "/me/second-factor")).statusCode).toBe(200);
	});

	test("an account from another provider is never asked", async () => {
		const jar = await signIn("alice");
		expect((await get(jar, "/auth/me")).json()).toMatchObject({ secondFactor: null });
		expect((await get(jar, "/me/settings")).statusCode).toBe(200);
		const status = await get(jar, "/me/second-factor");
		expect(status.statusCode).toBe(400);
		expect(status.json().code).toBe("NOT_LOCAL_PASSWORD");
	});

	test("enrolment shows a QR code and the secret, and lifts the gate for this session", async () => {
		const jar = await signIn("admin");
		const start = await post(jar, "/me/second-factor/totp/start");
		const body = start.json();
		expect(start.headers["cache-control"]).toBe("no-store");
		expect(body.qrCode).toMatch(/^data:image\/svg\+xml;base64,/);
		expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
		expect(body.uri).toContain(`secret=${body.secret}`);

		const secret = base32Decode(body.secret);
		const done = await post(jar, "/me/second-factor/totp", {
			token: body.token,
			code: totpCode(secret, totpStep(Date.now())),
		});
		expect(done.statusCode).toBe(200);
		expect(done.json().recoveryCodes).toHaveLength(10);
		expect((await get(jar, "/me/settings")).statusCode).toBe(200);

		const status = (await get(jar, "/me/second-factor")).json();
		expect(status.recoveryCodesLeft).toBe(10);
		expect(status.factors).toMatchObject([
			{ kind: "totp", label: "Authenticator app" },
		]);
		expect(await auditActions()).toEqual(["auth.second_factor_enrolled"]);
		// Neither the secret nor a code reaches the log.
		expect(JSON.stringify(lines)).not.toContain(body.secret);
		expect(JSON.stringify(lines)).not.toContain(done.json().recoveryCodes[0]);
	});

	test("a wrong first code or a forged token enrols nothing", async () => {
		const jar = await signIn("admin");
		const { token } = (await post(jar, "/me/second-factor/totp/start")).json();
		const wrong = await post(jar, "/me/second-factor/totp", { token, code: "000000" });
		expect(wrong.statusCode).toBe(403);
		expect(wrong.json().code).toBe("WRONG_CODE");
		const forged = await post(jar, "/me/second-factor/totp", {
			token: `${Date.now() + 60_000}.v1:AAAA`,
			code: "123456",
		});
		expect(forged.statusCode).toBe(400);
		const short = await post(jar, "/me/second-factor/totp", { token, code: "12" });
		expect(short.json().message).toBe("Enter the 6-digit code");
		expect((await get(jar, "/me/second-factor")).json().factors).toEqual([]);
	});

	test("the next sign-in must verify, even before changing a password", async () => {
		const first = await signIn("admin");
		const { secret } = await enrol(first);
		await testDb.db.updateTable("users").set({ must_change_password: true }).execute();

		const jar = await signIn("admin");
		expect((await get(jar, "/auth/me")).json()).toMatchObject({
			secondFactor: "verify",
		});
		const password = await post(jar, "/me/password", {
			currentPassword: "x",
			newPassword: "a long enough new password",
		});
		expect(password.json().code).toBe("SECOND_FACTOR_REQUIRED");
		// An unverified session cannot add a factor of its own.
		const add = await post(jar, "/me/second-factor/totp/start");
		expect(add.statusCode).toBe(403);

		const wrong = await post(jar, "/me/second-factor/verify", { code: "000000" });
		expect(wrong.statusCode).toBe(403);
		expect(wrong.json().code).toBe("WRONG_CODE");

		const next = totpStep(Date.now()) + 1;
		const ok = await post(jar, "/me/second-factor/verify", {
			code: totpCode(secret, next),
		});
		expect(ok.statusCode).toBe(204);
		expect((await get(jar, "/auth/me")).json()).toMatchObject({
			secondFactor: null,
			mustChangePassword: true,
		});
		expect(await auditActions()).toEqual([
			"auth.second_factor_enrolled",
			"auth.second_factor_failed",
			"auth.second_factor_verified",
		]);
	});

	test("a code works once, across sessions too", async () => {
		const first = await signIn("admin");
		const { secret } = await enrol(first);
		const code = totpCode(secret, totpStep(Date.now()) + 1);
		const a = await signIn("admin");
		const b = await signIn("admin");
		expect((await post(a, "/me/second-factor/verify", { code })).statusCode).toBe(204);
		expect((await post(b, "/me/second-factor/verify", { code })).statusCode).toBe(403);
	});

	test("a recovery code signs in once", async () => {
		const first = await signIn("admin");
		const { codes } = await enrol(first);
		const jar = await signIn("admin");
		const code = codes[0] as string;
		expect((await post(jar, "/me/second-factor/verify", { code })).statusCode).toBe(
			204,
		);
		expect((await get(jar, "/me/second-factor")).json().recoveryCodesLeft).toBe(9);
		const again = await signIn("admin");
		expect((await post(again, "/me/second-factor/verify", { code })).statusCode).toBe(
			403,
		);
	});

	test("ten wrong codes per account, then 429, audited once", async () => {
		const first = await signIn("admin");
		const { secret } = await enrol(first);
		const jar = await signIn("admin");
		for (let i = 0; i < 10; i++) {
			const res = await post(jar, "/me/second-factor/verify", { code: "WRONG-CODE" });
			expect(res.statusCode).toBe(403);
		}
		const refused = await post(jar, "/me/second-factor/verify", {
			code: totpCode(secret, totpStep(Date.now()) + 1),
		});
		expect(refused.statusCode).toBe(429);
		expect(refused.json().code).toBe("RATE_LIMITED");
		await post(jar, "/me/second-factor/verify", { code: "WRONG-CODE" });
		const throttled = await testDb.db
			.selectFrom("audit_events")
			.select("metadata")
			.where("action", "=", "auth.throttled")
			.execute();
		expect(throttled).toHaveLength(1);
		expect(throttled[0]?.metadata).toMatchObject({ scope: "second-factor" });
	});

	test("the last factor cannot be removed; a second one can be", async () => {
		const jar = await signIn("admin");
		await enrol(jar);
		const [only] = (await get(jar, "/me/second-factor")).json().factors;
		const remove = (id: string) =>
			app.inject({
				method: "DELETE",
				url: `/me/second-factor/${id}`,
				headers: csrfHeaders(jar, PUBLIC_URL),
			});
		const refused = await remove(only.id);
		expect(refused.statusCode).toBe(409);
		expect(refused.json().code).toBe("LAST_SECOND_FACTOR");

		await enrol(jar);
		expect((await remove(only.id)).statusCode).toBe(204);
		expect((await get(jar, "/me/second-factor")).json().factors).toHaveLength(1);
		expect((await remove(only.id)).statusCode).toBe(404);
	});
});

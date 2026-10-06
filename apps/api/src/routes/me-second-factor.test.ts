import { createSession } from "@portikus/auth";
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

	test("a new session secret, as on a restored server, leaves the factor working", async () => {
		const { secret } = await enrol(await signIn("admin"));
		await app.close();
		app = buildTestServer(testDb.db, mock.issuer, {
			SESSION_COOKIE_SECRET: "a rotated session secret, nothing like the first one",
		});
		await app.ready();
		const jar = await signIn("admin");
		const ok = await post(jar, "/me/second-factor/verify", {
			code: totpCode(secret, totpStep(Date.now()) + 1),
		});
		expect(ok.statusCode).toBe(204);
	});

	test("another second-factor key cannot open the factor", async () => {
		const { secret } = await enrol(await signIn("admin"));
		await app.close();
		app = buildTestServer(testDb.db, mock.issuer, {
			SECOND_FACTOR_KEY: "9a".repeat(32),
		});
		await app.ready();
		const jar = await signIn("admin");
		const refused = await post(jar, "/me/second-factor/verify", {
			code: totpCode(secret, totpStep(Date.now()) + 1),
		});
		expect(refused.statusCode).toBe(403);
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

	test("thirty wrong codes in a day stop the account for the day and tell its holder once", async () => {
		const first = await signIn("admin");
		const { secret } = await enrol(first);
		const jar = await signIn("admin");
		const start = Date.now();
		vi.useFakeTimers({ toFake: ["Date"], now: start });
		try {
			for (let window = 0; window < 3; window++) {
				vi.setSystemTime(start + window * 11 * 60_000);
				for (let i = 0; i < 10; i++) {
					const res = await post(jar, "/me/second-factor/verify", {
						code: "WRONG-CODE",
					});
					expect(res.statusCode).toBe(403);
				}
			}
			vi.setSystemTime(start + 3 * 11 * 60_000);
			const refused = await post(jar, "/me/second-factor/verify", {
				code: totpCode(secret, totpStep(Date.now())),
			});
			expect(refused.statusCode).toBe(429);
			vi.setSystemTime(start + 4 * 11 * 60_000);
			expect(
				(await post(jar, "/me/second-factor/verify", { code: "WRONG-CODE" }))
					.statusCode,
			).toBe(429);
		} finally {
			vi.useRealTimers();
		}
		const throttled = await testDb.db
			.selectFrom("audit_events")
			.select("metadata")
			.where("action", "=", "auth.throttled")
			.execute();
		expect(throttled).toHaveLength(1);
		expect(throttled[0]?.metadata).toMatchObject({ scope: "second-factor-daily" });
		const notices = await testDb.db
			.selectFrom("notifications")
			.select(["body", "kept"])
			.execute();
		expect(notices).toHaveLength(1);
		expect(notices[0]?.kept).toBe(true);
		expect(notices[0]?.body).toContain(
			"Someone entered many wrong two-step sign-in codes for your account today.",
		);
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

/** Register a software passkey, returning the recovery codes. */
async function enrolPasskey(jar: CookieJar, key: SoftPasskey): Promise<string[]> {
	const start = await post(jar, "/me/second-factor/webauthn/start");
	expect(start.statusCode).toBe(200);
	const done = await post(jar, "/me/second-factor/webauthn", {
		credential: key.register(start.json()),
		label: "Laptop",
	});
	expect(done.statusCode).toBe(200);
	return done.json().recoveryCodes;
}

async function passkeySignIn(jar: CookieJar, key: SoftPasskey) {
	const start = await post(jar, "/me/second-factor/webauthn/verify/start");
	expect(start.statusCode).toBe(200);
	return post(jar, "/me/second-factor/webauthn/verify", {
		credential: key.authenticate(start.json()),
	});
}

async function auditRows(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.select("metadata")
		.where("action", "=", action)
		.orderBy("id")
		.execute();
}

describe.skipIf(skip)("passkeys", () => {
	test("a passkey enrols at the gate and signs the next session in", async () => {
		const key = new SoftPasskey(PUBLIC_URL);
		const jar = await signIn("admin");
		const start = (await post(jar, "/me/second-factor/webauthn/start")).json();
		expect(start.rp.id).toBe(new URL(PUBLIC_URL).hostname);
		expect(start.authenticatorSelection.userVerification).toBe("preferred");
		const done = await post(jar, "/me/second-factor/webauthn", {
			credential: key.register(start),
		});
		expect(done.json().recoveryCodes).toHaveLength(10);
		expect((await get(jar, "/me/settings")).statusCode).toBe(200);
		expect((await get(jar, "/me/second-factor")).json().factors).toMatchObject([
			{ kind: "webauthn", label: "Passkey" },
		]);

		const next = await signIn("admin");
		expect((await get(next, "/auth/me")).json().secondFactor).toBe("verify");
		expect((await passkeySignIn(next, key)).statusCode).toBe(204);
		expect((await get(next, "/auth/me")).json().secondFactor).toBeNull();

		expect((await auditRows("auth.second_factor_enrolled"))[0]?.metadata).toMatchObject(
			{
				kind: "webauthn",
			},
		);
		expect((await auditRows("auth.second_factor_verified"))[0]?.metadata).toMatchObject(
			{
				kind: "webauthn",
				method: "webauthn",
			},
		);
	});

	test("a challenge answers once, and only its own ceremony", async () => {
		const key = new SoftPasskey(PUBLIC_URL);
		const jar = await signIn("admin");
		const start = (await post(jar, "/me/second-factor/webauthn/start")).json();
		const credential = key.register(start);
		expect(
			(await post(jar, "/me/second-factor/webauthn", { credential })).statusCode,
		).toBe(200);
		const again = await post(jar, "/me/second-factor/webauthn", { credential });
		expect(again.statusCode).toBe(400);
		expect(again.json().code).toBe("PASSKEY_EXPIRED");

		const next = await signIn("admin");
		const options = (
			await post(next, "/me/second-factor/webauthn/verify/start")
		).json();
		const answer = key.authenticate(options);
		const ok = await post(next, "/me/second-factor/webauthn/verify", {
			credential: answer,
		});
		expect(ok.statusCode).toBe(204);
		const other = await signIn("admin");
		const replayed = await post(other, "/me/second-factor/webauthn/verify", {
			credential: answer,
		});
		expect(replayed.json().code).toBe("PASSKEY_EXPIRED");
	});

	test("a copied key whose sign count went back is refused and audited", async () => {
		const key = new SoftPasskey(PUBLIC_URL);
		await enrolPasskey(await signIn("admin"), key);
		expect((await passkeySignIn(await signIn("admin"), key)).statusCode).toBe(204);
		key.counter = 0;
		const jar = await signIn("admin");
		const refused = await passkeySignIn(jar, key);
		expect(refused.statusCode).toBe(403);
		expect(refused.json().code).toBe("WRONG_PASSKEY");
		expect((await get(jar, "/auth/me")).json().secondFactor).toBe("verify");
		expect((await auditRows("auth.second_factor_failed"))[0]?.metadata).toMatchObject({
			kind: "webauthn",
			reason: "cloned",
		});
	});

	test("a passkey from another site is refused", async () => {
		const key = new SoftPasskey("https://evil.example");
		const jar = await signIn("admin");
		const start = (await post(jar, "/me/second-factor/webauthn/start")).json();
		const res = await post(jar, "/me/second-factor/webauthn", {
			credential: key.register(start),
		});
		expect(res.statusCode).toBe(403);
		expect((await get(jar, "/me/second-factor")).json().factors).toEqual([]);
	});

	test("an unverified session cannot add a passkey", async () => {
		await enrol(await signIn("admin"));
		const jar = await signIn("admin");
		expect((await post(jar, "/me/second-factor/webauthn/start")).statusCode).toBe(403);
		// It has no passkey to sign in with either.
		const start = await post(jar, "/me/second-factor/webauthn/verify/start");
		expect(start.json().code).toBe("NO_PASSKEY");
	});
});

describe.skipIf(skip)("managing factors", () => {
	test("a factor can be renamed by its owner only", async () => {
		const jar = await signIn("admin");
		await enrol(jar);
		const [factor] = (await get(jar, "/me/second-factor")).json().factors;
		const rename = (who: CookieJar, label: string) =>
			app.inject({
				method: "PATCH",
				url: `/me/second-factor/${factor.id}`,
				headers: csrfHeaders(who, PUBLIC_URL),
				payload: { label },
			});
		expect((await rename(jar, "  Work phone ")).statusCode).toBe(204);
		expect((await get(jar, "/me/second-factor")).json().factors[0].label).toBe(
			"Work phone",
		);
		expect((await rename(jar, "")).statusCode).toBe(400);
		expect((await rename(await signIn("alice"), "Mine")).statusCode).toBe(404);
	});

	test("new recovery codes replace the old ones", async () => {
		const jar = await signIn("admin");
		const { codes: old } = await enrol(jar);
		const res = await post(jar, "/me/second-factor/recovery-codes");
		expect(res.statusCode).toBe(200);
		expect(res.headers["cache-control"]).toBe("no-store");
		const fresh: string[] = res.json().recoveryCodes;
		expect(fresh).toHaveLength(10);
		expect(fresh).not.toContain(old[0]);
		expect(await auditRows("auth.second_factor_recovery_codes_replaced")).toHaveLength(
			1,
		);

		const next = await signIn("admin");
		const stale = await post(next, "/me/second-factor/verify", { code: old[0] });
		expect(stale.statusCode).toBe(403);
		const ok = await post(next, "/me/second-factor/verify", { code: fresh[0] });
		expect(ok.statusCode).toBe(204);
		expect(JSON.stringify(lines)).not.toContain(fresh[1]);
	});

	test("an unverified session cannot make new recovery codes", async () => {
		await enrol(await signIn("admin"));
		const jar = await signIn("admin");
		const res = await post(jar, "/me/second-factor/recovery-codes");
		expect(res.json().code).toBe("SECOND_FACTOR_REQUIRED");
	});

	test("removal records the kind", async () => {
		const jar = await signIn("admin");
		await enrol(jar);
		await enrolPasskey(jar, new SoftPasskey(PUBLIC_URL));
		const passkey = (await get(jar, "/me/second-factor"))
			.json()
			.factors.find((f: { kind: string }) => f.kind === "webauthn");
		const res = await app.inject({
			method: "DELETE",
			url: `/me/second-factor/${passkey.id}`,
			headers: csrfHeaders(jar, PUBLIC_URL),
		});
		expect(res.statusCode).toBe(204);
		expect((await auditRows("auth.second_factor_removed"))[0]?.metadata).toMatchObject({
			kind: "webauthn",
		});
	});
});

describe.skipIf(skip)("a course launch into a local-password account", () => {
	/** Lena enrolled, plus a launch session into her account as a linked course identity starts. */
	async function launched(): Promise<{ jar: CookieJar; factorId: string }> {
		const own = await signIn("lena");
		await enrol(own);
		const [factor] = (await get(own, "/me/second-factor")).json().factors;
		const row = await testDb.db
			.selectFrom("users")
			.select("id")
			.where("email", "=", "lena@example.edu")
			.executeTakeFirstOrThrow();
		const session = await createSession(testDb.db, row.id, 3600, {
			method: "lti",
			courseUserId: null,
		});
		const jar = new CookieJar();
		jar.capture(`portikus_session=${session.token}`);
		return { jar, factorId: factor.id };
	}

	function refusedAsLaunch(res: { statusCode: number; json: () => { code: string } }) {
		expect(res.statusCode).toBe(403);
		expect(res.json().code).toBe("FORBIDDEN");
	}

	test("cannot remove the account's factors, even the last one", async () => {
		const { jar, factorId } = await launched();
		refusedAsLaunch(
			await app.inject({
				method: "DELETE",
				url: `/me/second-factor/${factorId}`,
				headers: csrfHeaders(jar, PUBLIC_URL),
			}),
		);
		const left = await testDb.db
			.selectFrom("user_second_factors")
			.select("id")
			.execute();
		expect(left).toHaveLength(1);
	});

	test("cannot add a factor, rename one, or make new recovery codes", async () => {
		const { jar, factorId } = await launched();
		refusedAsLaunch(await post(jar, "/me/second-factor/totp/start"));
		refusedAsLaunch(
			await post(jar, "/me/second-factor/totp", { token: "x", code: "1" }),
		);
		refusedAsLaunch(await post(jar, "/me/second-factor/webauthn/start"));
		refusedAsLaunch(await post(jar, "/me/second-factor/recovery-codes"));
		refusedAsLaunch(
			await app.inject({
				method: "PATCH",
				url: `/me/second-factor/${factorId}`,
				headers: csrfHeaders(jar, PUBLIC_URL),
				payload: { label: "Attacker" },
			}),
		);
	});
});

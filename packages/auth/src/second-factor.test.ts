import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { dexLocalSubject } from "./dex-subject.js";
import {
	accountNeedsSecondFactor,
	checkSecondFactor,
	enrolTotp,
	generateRecoveryCodes,
	hashRecoveryCode,
	markSecondFactorPassed,
	openPendingTotp,
	openSecret,
	RECOVERY_CODE_COUNT,
	resetSecondFactor,
	sealPendingTotp,
	sealSecret,
	secondFactorApplies,
	secondFactorKey,
} from "./second-factor.js";
import { createSession, hashSessionToken, loadSession } from "./sessions.js";
import { generateTotpSecret, totpCode, totpStep } from "./totp.js";

const key = secondFactorKey("5f".repeat(32));
const USER = "6f1c1a8e-1d3b-4b7e-9a51-1d2c3b4a5e6f";

describe("sealing secrets (SPEC.md section 24.13)", () => {
	test("a sealed secret opens with the same key and context only", () => {
		const secret = generateTotpSecret();
		const sealed = sealSecret(key, secret, "totp:a");
		expect(sealed).not.toContain(secret.toString("base64url"));
		expect(openSecret(key, sealed, "totp:a")).toEqual(secret);
		expect(openSecret(key, sealed, "totp:b")).toBeNull();
		expect(openSecret(secondFactorKey("a0".repeat(32)), sealed, "totp:a")).toBeNull();
		expect(openSecret(key, `${sealed.slice(0, -2)}AA`, "totp:a")).toBeNull();
	});

	test("the key comes from 32 bytes of hex and nothing shorter", () => {
		const sealed = sealSecret(key, Buffer.from("x"), "totp:a");
		expect(openSecret(secondFactorKey("5F".repeat(32)), sealed, "totp:a")).toEqual(
			Buffer.from("x"),
		);
		expect(() => secondFactorKey("5f".repeat(31))).toThrow(/64 hexadecimal/);
		expect(() => secondFactorKey("a test platform secret")).toThrow(/64 hexadecimal/);
	});

	test("a started enrolment opens for its account until it expires", () => {
		const secret = generateTotpSecret();
		const now = Date.now();
		const token = sealPendingTotp(key, USER, secret, now);
		expect(openPendingTotp(key, USER, token, now + 60_000)).toEqual(secret);
		expect(openPendingTotp(key, "someone-else", token, now)).toBeNull();
		expect(openPendingTotp(key, USER, token, now + 11 * 60_000)).toBeNull();
		// A later expiry written over the token does not open it.
		const forged = `${now + 3_600_000}${token.slice(token.indexOf("."))}`;
		expect(openPendingTotp(key, USER, forged, now + 11 * 60_000)).toBeNull();
	});
});

describe("recovery codes", () => {
	test("ten distinct codes, hashed ignoring case, spaces and dashes", () => {
		const codes = generateRecoveryCodes();
		expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
		expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
		for (const code of codes) expect(code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
		const code = codes[0] as string;
		expect(hashRecoveryCode(code.toLowerCase().replace(/-/g, " "))).toBe(
			hashRecoveryCode(code),
		);
	});
});

describe("who needs a second factor", () => {
	const local = dexLocalSubject("ada");
	test("a Dex local password signing in through Dex", () => {
		expect(
			secondFactorApplies({
				oidc_issuer: "https://dex",
				oidc_subject: local,
				method: "oidc",
			}),
		).toBe(true);
	});
	test("not another Dex connector, a course account, or a course launch", () => {
		expect(
			secondFactorApplies({
				oidc_issuer: "https://dex",
				oidc_subject: "CgNhZGESBWVudHJh",
				method: "oidc",
			}),
		).toBe(false);
		expect(
			secondFactorApplies({
				oidc_issuer: "lti:https://lms",
				oidc_subject: local,
				method: "lti",
			}),
		).toBe(false);
		expect(
			secondFactorApplies({
				oidc_issuer: "https://dex",
				oidc_subject: local,
				method: "lti",
			}),
		).toBe(false);
	});
});

describe("which accounts must keep a second factor", () => {
	test("a Dex local-password account, whatever session it is in", () => {
		const local = dexLocalSubject("ada");
		expect(
			accountNeedsSecondFactor({ oidc_issuer: "https://dex", oidc_subject: local }),
		).toBe(true);
		expect(
			accountNeedsSecondFactor({
				oidc_issuer: "https://dex",
				oidc_subject: "CgNhZGESBWVudHJh",
			}),
		).toBe(false);
		expect(
			accountNeedsSecondFactor({ oidc_issuer: "lti:https://lms", oidc_subject: local }),
		).toBe(false);
	});
});

describe("second factors in the database", () => {
	let t: TestDb;

	beforeAll(async () => {
		if (hasTestDb()) t = await createTestDb();
	});
	afterAll(async () => {
		await t?.close();
	});
	beforeEach(async () => {
		if (hasTestDb()) await t.truncate();
	});

	async function localUser(subject = dexLocalSubject("ada")): Promise<string> {
		const row = await t.db
			.insertInto("users")
			.values({
				oidc_issuer: "https://dex.example.edu",
				oidc_subject: subject,
				display_name: "Ada",
				role: "student",
				provider_role: "student",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		return row.id;
	}

	async function enrol(userId: string, sessionToken: string, now = Date.now()) {
		const secret = generateTotpSecret();
		const codes = await enrolTotp(t.db, key, {
			userId,
			secret,
			label: "Phone",
			step: totpStep(now) - 1,
			sessionId: hashSessionToken(sessionToken),
			actor: `user:${userId}`,
			metadata: {},
		});
		return { secret, codes };
	}

	test.skipIf(!hasTestDb())(
		"a local-password session must enrol, then verify in each new session",
		async () => {
			const userId = await localUser();
			const first = await createSession(t.db, userId, 3600, {
				method: "oidc",
				courseUserId: null,
			});
			expect((await loadSession(t.db, first.token))?.secondFactor).toBe("enrol");
			expect((await loadSession(t.db, first.token))?.secondFactorApplies).toBe(true);

			await enrol(userId, first.token);
			expect((await loadSession(t.db, first.token))?.secondFactor).toBeNull();

			const second = await createSession(t.db, userId, 3600, {
				method: "oidc",
				courseUserId: null,
			});
			expect((await loadSession(t.db, second.token))?.secondFactor).toBe("verify");
			await markSecondFactorPassed(t.db, hashSessionToken(second.token));
			expect((await loadSession(t.db, second.token))?.secondFactor).toBeNull();
		},
	);

	test.skipIf(!hasTestDb())(
		"other accounts and course launches owe nothing",
		async () => {
			const userId = await localUser("not-a-dex-subject");
			const session = await createSession(t.db, userId, 3600, {
				method: "oidc",
				courseUserId: null,
			});
			expect((await loadSession(t.db, session.token))?.secondFactor).toBeNull();
			expect((await loadSession(t.db, session.token))?.secondFactorApplies).toBe(false);
			const local = await localUser();
			const launch = await createSession(t.db, local, 3600, {
				method: "lti",
				courseUserId: null,
			});
			expect((await loadSession(t.db, launch.token))?.secondFactor).toBeNull();
			expect((await loadSession(t.db, launch.token))?.secondFactorApplies).toBe(false);
		},
	);

	test.skipIf(!hasTestDb())(
		"the secret is stored sealed and enrolment is audited",
		async () => {
			const userId = await localUser();
			const session = await createSession(t.db, userId, 3600, {
				method: "oidc",
				courseUserId: null,
			});
			const { secret } = await enrol(userId, session.token);
			const row = await t.db
				.selectFrom("user_second_factors")
				.select("secret")
				.executeTakeFirstOrThrow();
			expect(row.secret).not.toContain(secret.toString("hex"));
			expect(row.secret.startsWith("v1:")).toBe(true);
			const audit = await t.db
				.selectFrom("audit_events")
				.select(["action", "metadata"])
				.execute();
			expect(audit.map((a) => a.action)).toContain("auth.second_factor_enrolled");
			expect(JSON.stringify(audit)).not.toContain(secret.toString("base64url"));
		},
	);

	test.skipIf(!hasTestDb())("a TOTP code works once", async () => {
		const userId = await localUser();
		const session = await createSession(t.db, userId, 3600, {
			method: "oidc",
			courseUserId: null,
		});
		const now = Date.now();
		const { secret } = await enrol(userId, session.token, now);
		const code = totpCode(secret, totpStep(now));
		expect(await checkSecondFactor(t.db, key, userId, code, now)).toEqual({
			ok: true,
			method: "totp",
		});
		expect(await checkSecondFactor(t.db, key, userId, code, now)).toEqual({
			ok: false,
		});
		// The step the enrolment confirmed with is spent too.
		const enrolled = totpCode(secret, totpStep(now) - 1);
		expect(await checkSecondFactor(t.db, key, userId, enrolled, now)).toEqual({
			ok: false,
		});
	});

	test.skipIf(!hasTestDb())("parallel tries of one code succeed once", async () => {
		const userId = await localUser();
		const session = await createSession(t.db, userId, 3600, {
			method: "oidc",
			courseUserId: null,
		});
		const now = Date.now();
		const { secret } = await enrol(userId, session.token, now);
		const code = totpCode(secret, totpStep(now));
		const results = await Promise.all(
			Array.from({ length: 5 }, () => checkSecondFactor(t.db, key, userId, code, now)),
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
	});

	test.skipIf(!hasTestDb())(
		"a recovery code works once, a wrong one never",
		async () => {
			const userId = await localUser();
			const session = await createSession(t.db, userId, 3600, {
				method: "oidc",
				courseUserId: null,
			});
			const { codes } = await enrol(userId, session.token);
			const code = (codes[3] as string).toLowerCase();
			expect(await checkSecondFactor(t.db, key, userId, code)).toEqual({
				ok: true,
				method: "recovery_code",
			});
			expect(await checkSecondFactor(t.db, key, userId, code)).toEqual({ ok: false });
			expect(await checkSecondFactor(t.db, key, userId, "AAAA-BBBB-CCCC-DDDD")).toEqual(
				{
					ok: false,
				},
			);
			const stored = await t.db
				.selectFrom("user_recovery_codes")
				.select("code_hash")
				.execute();
			expect(stored).toHaveLength(RECOVERY_CODE_COUNT);
			expect(JSON.stringify(stored)).not.toContain(codes[0]);
		},
	);

	test.skipIf(!hasTestDb())(
		"a reset removes factors and codes, sends sessions back to enrolment and is audited",
		async () => {
			const userId = await localUser();
			const session = await createSession(t.db, userId, 3600, {
				method: "oidc",
				courseUserId: null,
			});
			const { codes } = await enrol(userId, session.token);
			await resetSecondFactor(t.db, userId, "user:someone");
			expect((await loadSession(t.db, session.token))?.secondFactor).toBe("enrol");
			expect(
				await t.db.selectFrom("user_second_factors").select("id").execute(),
			).toHaveLength(0);
			expect(await checkSecondFactor(t.db, key, userId, codes[0] as string)).toEqual({
				ok: false,
			});
			const audit = await t.db
				.selectFrom("audit_events")
				.select(["action", "actor", "target"])
				.where("action", "=", "auth.second_factor_reset")
				.executeTakeFirstOrThrow();
			expect(audit).toMatchObject({ actor: "user:someone", target: userId });
		},
	);
});

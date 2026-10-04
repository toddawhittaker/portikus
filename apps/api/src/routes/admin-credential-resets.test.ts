import {
	createOidcClient,
	createSession,
	dexLocalSubject,
	LOCAL_ADMIN_USER_ID,
	precreateDexAccount,
} from "@portikus/auth";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { INSTALL_ADMIN_REFUSAL } from "../admin/install-admin.js";
import { RESET_NOTICE_TITLES } from "../admin/reset-notice.js";
import { toAuthOptions } from "../auth-options.js";
import { buildServer } from "../server.js";
import { stubDex } from "../testing/stub-dex.js";
import { PUBLIC_URL, testConfig } from "../testing/test-support.js";

/**
 * Administrator resets of a password or second factor tell the holder,
 * and the install administrator is protected from other administrators
 * (SPEC.md sections 5.1 and 24.13).
 */

const skip = !hasTestDb();

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let stub: ReturnType<typeof stubDex>;

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

async function adminJar(): Promise<CookieJar> {
	const jar = new CookieJar();
	await loginAs(app, "carol", jar);
	return jar;
}

function post(jar: CookieJar, url: string) {
	return app.inject({ method: "POST", url, headers: csrfHeaders(jar, PUBLIC_URL) });
}

/** A Dex local account with a password in the stub, as `Add user` makes. */
async function dexAccount(
	dexUserId: string,
	email: string,
	role: "student" | "administrator",
) {
	const id = await precreateDexAccount(testDb.db, mock.issuer, {
		userId: dexUserId,
		email,
		username: email.split("@")[0] ?? "x",
		displayName: email,
		role,
	});
	stub.passwords.set(email, { email, username: "x", userId: dexUserId, hash: "h" });
	return id;
}

async function idOf(subject: string): Promise<string> {
	const row = await testDb.db
		.selectFrom("users")
		.select("id")
		.where("oidc_subject", "=", subject)
		.executeTakeFirstOrThrow();
	return row.id;
}

async function notices(userId: string) {
	return testDb.db
		.selectFrom("notifications")
		.select(["title", "body", "tone"])
		.where("user_id", "=", userId)
		.execute();
}

async function auditRows(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.select(["actor", "target", "result", "metadata"])
		.where("action", "=", action)
		.orderBy("id")
		.execute();
}

describe.skipIf(skip)("Reset two-factor sign-in", () => {
	test("clears the factors, ends sessions, audits, and tells the holder", async () => {
		const carol = await adminJar();
		const hal = await dexAccount(crypto.randomUUID(), "hal@example.edu", "student");
		await testDb.db
			.insertInto("user_second_factors")
			.values({ user_id: hal, kind: "totp", secret: "s", label: "phone" })
			.execute();
		await createSession(testDb.db, hal, 3600, { method: "oidc", courseUserId: null });

		const res = await post(carol, `/admin/dex-users/${hal}/reset-second-factor`);
		expect(res.statusCode).toBe(200);

		const factors = await testDb.db
			.selectFrom("user_second_factors")
			.select("id")
			.where("user_id", "=", hal)
			.execute();
		expect(factors).toEqual([]);
		const sessions = await testDb.db
			.selectFrom("sessions")
			.select("id")
			.where("user_id", "=", hal)
			.execute();
		expect(sessions).toEqual([]);
		expect(await auditRows("auth.second_factor_reset")).toEqual([
			{ actor: `user:${await idOf("carol")}`, target: hal, result: "ok", metadata: {} },
		]);
		const [notice] = await notices(hal);
		expect(notice?.title).toBe(RESET_NOTICE_TITLES.second_factor);
		expect(notice?.body).toMatch(
			/^An administrator reset your two-factor sign-in on \d{4}-\d{2}-\d{2}\. If you did not ask for this, tell your instructor or the site administrator\.$/,
		);
	});

	test("refuses the caller's own account and an account with no Dex password", async () => {
		const carol = await adminJar();
		const own = await post(
			carol,
			`/admin/dex-users/${await idOf("carol")}/reset-second-factor`,
		);
		expect(own.statusCode).toBe(400);
		await loginAs(app, "alice", new CookieJar());
		const sso = await post(
			carol,
			`/admin/dex-users/${await idOf("alice")}/reset-second-factor`,
		);
		expect(sso.statusCode).toBe(400);
	});
});

describe.skipIf(skip)("The holder is told", () => {
	test("a password reset writes a notice", async () => {
		const carol = await adminJar();
		const hal = await dexAccount(crypto.randomUUID(), "hal@example.edu", "student");
		expect(
			(await post(carol, `/admin/dex-users/${hal}/reset-password`)).statusCode,
		).toBe(200);
		const list = await notices(hal);
		expect(list.map((n) => n.title)).toEqual([RESET_NOTICE_TITLES.password]);
		expect(list[0]?.body).toContain("An administrator reset your password on ");
	});

	test("both resets give one notice that names both", async () => {
		const carol = await adminJar();
		const hal = await dexAccount(crypto.randomUUID(), "hal@example.edu", "student");
		await post(carol, `/admin/dex-users/${hal}/reset-password`);
		await post(carol, `/admin/dex-users/${hal}/reset-second-factor`);
		const list = await notices(hal);
		expect(list.map((n) => n.title)).toEqual([RESET_NOTICE_TITLES.both]);
		expect(list[0]?.body).toContain(
			"An administrator reset your password and your two-factor sign-in on ",
		);
	});
});

describe.skipIf(skip)("Install administrator protection", () => {
	const actions: [string, (id: string) => string, string][] = [
		[
			"reset password",
			(id) => `/admin/dex-users/${id}/reset-password`,
			"dex_user.password_reset",
		],
		[
			"reset second factor",
			(id) => `/admin/dex-users/${id}/reset-second-factor`,
			"auth.second_factor_reset",
		],
		["remove", (id) => `/admin/dex-users/${id}/remove`, "dex_user.removed"],
		["disable", (id) => `/admin/users/${id}/disable`, "user.disabled"],
		["demote", (id) => `/admin/users/${id}/demote`, "user.role_changed"],
		["promote", (id) => `/admin/users/${id}/promote`, "user.role_changed"],
		[
			"make instructor",
			(id) => `/admin/users/${id}/make-instructor`,
			"user.role_changed",
		],
		[
			"remove instructor",
			(id) => `/admin/users/${id}/remove-instructor`,
			"user.role_changed",
		],
	];

	for (const [name, url, action] of actions) {
		test(`another administrator cannot ${name} it, and the attempt is audited`, async () => {
			const carol = await adminJar();
			const installAdmin = await dexAccount(
				LOCAL_ADMIN_USER_ID,
				"admin@example.edu",
				"administrator",
			);
			const res = await post(carol, url(installAdmin));
			expect(res.statusCode).toBe(403);
			expect(res.json().message).toBe(INSTALL_ADMIN_REFUSAL);
			const rows = await auditRows(action);
			expect(rows).toEqual([
				{
					actor: `user:${await idOf("carol")}`,
					target: installAdmin,
					result: "denied",
					metadata: expect.objectContaining({ reason: "install_administrator" }),
				},
			]);
			const row = await testDb.db
				.selectFrom("users")
				.select(["role", "disabled_at"])
				.where("id", "=", installAdmin)
				.executeTakeFirstOrThrow();
			expect(row).toEqual({ role: "administrator", disabled_at: null });
			expect(await notices(installAdmin)).toEqual([]);
		});
	}

	test("the install administrator can act on itself and on others", async () => {
		const carol = await adminJar();
		const carolId = await idOf("carol");
		// Carol's own account becomes the install administrator.
		await testDb.db
			.updateTable("users")
			.set({
				oidc_issuer: mock.issuer,
				oidc_subject: dexLocalSubject(LOCAL_ADMIN_USER_ID),
			})
			.where("id", "=", carolId)
			.execute();
		// A Dex local account must pass the second-factor gate first.
		await testDb.db
			.updateTable("sessions")
			.set({ second_factor_at: new Date().toISOString() })
			.where("user_id", "=", carolId)
			.execute();
		// Not the guard's 403: only the existing self-refusal applies.
		const own = await post(carol, `/admin/users/${carolId}/disable`);
		expect(own.statusCode).toBe(400);
		expect(own.json().message).not.toBe(INSTALL_ADMIN_REFUSAL);
		expect(await auditRows("user.disabled")).toEqual([]);
		const hal = await dexAccount(crypto.randomUUID(), "hal@example.edu", "student");
		expect((await post(carol, `/admin/users/${hal}/make-instructor`)).statusCode).toBe(
			200,
		);
	});
});

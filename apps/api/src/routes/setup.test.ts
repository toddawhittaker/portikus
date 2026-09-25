import {
	createOidcClient,
	createSession,
	type DexApi,
	issueSetupCode,
	sessionCookieName,
} from "@portikus/auth";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import {
	createTestDb,
	hasTestDb,
	insertTestLtiUser,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { toAuthOptions } from "../auth-options.js";
import { buildServer } from "../server.js";
import { PUBLIC_URL, testConfig } from "../test-support.js";

/**
 * The first administrator's routes (docs/EPIC-14.md rulings 15 to 18 and
 * "Security invariants to test"). A code is single use, expires, is refused
 * for a course account, is throttled, and never reaches a log or audit row.
 */

const skip = !hasTestDb();

/** Dex's passwords, by email, as the gRPC client would see them. */
function stubDex() {
	const passwords = new Map<
		string,
		{ email: string; username: string; userId: string; hash: string }
	>();
	const dex: DexApi = {
		async createPassword(input) {
			if (passwords.has(input.email)) return "already_exists";
			passwords.set(input.email, { ...input });
			return "created";
		},
		async updatePassword() {
			return "not_found";
		},
		async deletePassword(email) {
			return passwords.delete(email) ? "deleted" : "not_found";
		},
		async listPasswords() {
			return [...passwords.values()];
		},
		close() {},
	};
	return { dex, passwords };
}

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let lines: Record<string, unknown>[];
let stub: ReturnType<typeof stubDex>;

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

/** A fresh server, with or without Dex's gRPC API. */
async function start(options: { dex: boolean }): Promise<void> {
	stub = stubDex();
	const collected = collectingLogger("debug");
	lines = collected.lines;
	const config = testConfig(mock.issuer);
	app = buildServer({
		db: testDb.db,
		config,
		logger: collected.logger,
		oidc: createOidcClient(toAuthOptions(config)),
		...(options.dex ? { dex: stub.dex } : {}),
	});
	await app.ready();
}

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	return async () => {
		await app?.close();
	};
});

async function signedIn(user: string): Promise<CookieJar> {
	const jar = new CookieJar();
	await loginAs(app, user, jar);
	return jar;
}

function claim(jar: CookieJar, code: string, ip = "203.0.113.5") {
	return app.inject({
		method: "POST",
		url: "/setup/claim",
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: { code },
		remoteAddress: ip,
	});
}

async function roleOf(jar: CookieJar): Promise<string> {
	const me = await app.inject({
		method: "GET",
		url: "/auth/me",
		headers: { cookie: jar.cookieHeader() },
	});
	return me.json().role;
}

async function auditRows(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.select(["actor", "target", "result", "metadata"])
		.where("action", "=", action)
		.orderBy("id")
		.execute();
}

/** Neither the code nor any group of it appears in the logs or the audit log. */
async function expectNoTraceOf(code: string): Promise<void> {
	const audits = JSON.stringify(
		await testDb.db.selectFrom("audit_events").selectAll().execute(),
	);
	const logs = JSON.stringify(lines);
	for (const part of [code, code.replace(/-/g, ""), ...code.split("-")]) {
		expect(audits).not.toContain(part);
		expect(logs).not.toContain(part);
	}
}

describe.skipIf(skip)("POST /setup/claim", () => {
	beforeEach(() => start({ dex: false }));

	test("a signed-in SSO account becomes administrator by grant, once", async () => {
		const code = await issueSetupCode(testDb.db);
		const alice = await signedIn("alice");
		expect(await roleOf(alice)).toBe("student");

		const res = await claim(alice, code);
		expect(res.statusCode).toBe(204);
		expect(await roleOf(alice)).toBe("administrator");
		const row = await testDb.db
			.selectFrom("users")
			.select(["id", "provider_role", "granted_role"])
			.where("oidc_subject", "=", "alice")
			.executeTakeFirstOrThrow();
		expect(row).toMatchObject({
			provider_role: "student",
			granted_role: "administrator",
		});

		expect(await auditRows("setup.code_claimed")).toMatchObject([
			{ actor: `user:${row.id}`, target: row.id, result: "ok" },
		]);
		const changed = await auditRows("user.role_changed");
		expect(changed).toHaveLength(1);
		expect(changed[0]?.metadata).toMatchObject({
			from: "student",
			to: "administrator",
			source: "setup",
		});

		// Single use: the next person is refused with the generic answer.
		const bob = await signedIn("bob");
		const again = await claim(bob, code);
		expect(again.statusCode).toBe(400);
		expect(again.json().message).toBe("That code is not valid.");
		expect(await roleOf(bob)).toBe("student");
		await expectNoTraceOf(code);
	});

	test("a wrong or expired code gets one generic answer and a failed audit row", async () => {
		const alice = await signedIn("alice");
		const code = await issueSetupCode(testDb.db, new Date(Date.now() - 61 * 60_000));
		const expired = await claim(alice, code);
		const wrong = await claim(alice, "ZZZZ-ZZZZ-ZZZZ-ZZZZ");
		const garbage = await claim(alice, "hello");
		for (const res of [expired, wrong, garbage]) {
			expect(res.statusCode).toBe(400);
			expect(res.json().message).toBe("That code is not valid.");
		}
		expect((await auditRows("setup.code_claimed")).map((r) => r.result)).toEqual([
			"failed",
			"failed",
			"failed",
		]);
		expect(await roleOf(alice)).toBe("student");
		await expectNoTraceOf(code);
	});

	test("a course account is refused and does not use up the code", async () => {
		const code = await issueSetupCode(testDb.db);
		const courseUser = await insertTestLtiUser(testDb.db);
		const session = await createSession(testDb.db, courseUser, 3600, {
			method: "lti",
			courseUserId: null,
		});
		const jar = new CookieJar();
		jar.capture(
			`${sessionCookieName(toAuthOptions(testConfig(mock.issuer)))}=${session.token}`,
		);
		const res = await claim(jar, code);
		expect(res.statusCode).toBe(403);

		const alice = await signedIn("alice");
		expect((await claim(alice, code)).statusCode).toBe(204);
	});

	test("a course sign-in session of an SSO account is refused", async () => {
		const code = await issueSetupCode(testDb.db);
		const userId = await insertTestUser(testDb.db, { oidc_issuer: mock.issuer });
		const session = await createSession(testDb.db, userId, 3600, {
			method: "lti",
			courseUserId: null,
		});
		const jar = new CookieJar();
		jar.capture(
			`${sessionCookieName(toAuthOptions(testConfig(mock.issuer)))}=${session.token}`,
		);
		expect((await claim(jar, code)).statusCode).toBe(403);
	});

	test("refuses a caller who is signed out, or a post from another origin", async () => {
		const code = await issueSetupCode(testDb.db);
		const anonymous = await app.inject({
			method: "POST",
			url: "/setup/claim",
			headers: { origin: new URL(PUBLIC_URL).origin },
			payload: { code },
		});
		expect(anonymous.statusCode).toBe(401);
		const alice = await signedIn("alice");
		const crossSite = await app.inject({
			method: "POST",
			url: "/setup/claim",
			headers: { cookie: alice.cookieHeader(), origin: "https://evil.example" },
			payload: { code },
		});
		expect(crossSite.statusCode).toBe(403);
		expect(await roleOf(alice)).toBe("student");
	});

	test("allows ten attempts per address in ten minutes, then answers 429", async () => {
		const alice = await signedIn("alice");
		const code = await issueSetupCode(testDb.db);
		for (let i = 0; i < 10; i++) {
			expect((await claim(alice, "ZZZZ-ZZZZ-ZZZZ-ZZZZ")).statusCode).toBe(400);
		}
		// Even the right code is refused once the address is over its limit.
		expect((await claim(alice, code)).statusCode).toBe(429);
		expect((await claim(alice, code)).statusCode).toBe(429);
		const throttled = await auditRows("auth.throttled");
		expect(throttled).toHaveLength(1);
		expect(throttled[0]?.metadata).toMatchObject({ scope: "setup" });
		// Another address has its own count.
		expect((await claim(alice, code, "198.51.100.7")).statusCode).toBe(204);
	});
});

const FIRST = {
	email: "Owner@Example.edu",
	username: "owner",
	password: "correct horse battery",
};

function firstAccount(body: object, ip = "203.0.113.9") {
	return app.inject({
		method: "POST",
		url: "/setup/first-account",
		headers: { origin: new URL(PUBLIC_URL).origin },
		payload: body,
		remoteAddress: ip,
	});
}

async function state(): Promise<boolean> {
	const res = await app.inject({ method: "GET", url: "/setup/state" });
	expect(res.statusCode).toBe(200);
	return res.json().firstAccount;
}

/** Make the next commit of a users row with this email fail, as a lost database would. */
async function failCommitFor(email: string): Promise<() => Promise<void>> {
	await sql`create function doom() returns trigger language plpgsql as $$
		begin raise exception 'commit refused'; end $$`.execute(testDb.db);
	await sql
		.raw(
			`create constraint trigger doom after insert on users deferrable initially deferred
			for each row when (lower(new.email) = lower('${email}')) execute function doom()`,
		)
		.execute(testDb.db);
	return async () => {
		await sql`drop trigger doom on users`.execute(testDb.db);
		await sql`drop function doom()`.execute(testDb.db);
	};
}

describe.skipIf(skip)("POST /setup/first-account under standalone Dex", () => {
	beforeEach(() => start({ dex: true }));

	test("creates the Dex password and an administrator account in one step", async () => {
		expect(await state()).toBe(true);
		const code = await issueSetupCode(testDb.db);
		const res = await firstAccount({ ...FIRST, code });
		expect(res.statusCode).toBe(204);

		const dex = stub.passwords.get("owner@example.edu");
		expect(dex?.username).toBe("owner");
		expect(await bcrypt.compare(FIRST.password, dex?.hash ?? "")).toBe(true);
		const user = await testDb.db
			.selectFrom("users")
			.select(["id", "oidc_issuer", "oidc_subject", "role", "granted_role"])
			.executeTakeFirstOrThrow();
		expect(user).toMatchObject({
			oidc_issuer: mock.issuer,
			role: "administrator",
			granted_role: "administrator",
		});
		const codeRow = await testDb.db
			.selectFrom("setup_codes")
			.select(["used_by", "used_at"])
			.executeTakeFirstOrThrow();
		expect(codeRow.used_by).toBe(user.id);
		expect((await auditRows("user.role_changed"))[0]?.metadata).toMatchObject({
			source: "setup",
		});

		// Once an administrator exists the form is gone.
		expect(await state()).toBe(false);
		const code2 = await issueSetupCode(testDb.db);
		const again = await firstAccount({
			...FIRST,
			email: "two@example.edu",
			code: code2,
		});
		expect(again.statusCode).toBe(404);
		await expectNoTraceOf(code);
		expect(JSON.stringify(lines)).not.toContain(FIRST.password);
	});

	test("a failed commit after Dex made the password removes that password", async () => {
		const code = await issueSetupCode(testDb.db);
		const undo = await failCommitFor(FIRST.email);
		try {
			const res = await firstAccount({ ...FIRST, code });
			expect(res.statusCode).toBe(500);
		} finally {
			await undo();
		}
		expect(stub.passwords.size).toBe(0);
		expect(await state()).toBe(true);
	});

	test("checks the code before creating anything", async () => {
		await issueSetupCode(testDb.db);
		const res = await firstAccount({ ...FIRST, code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" });
		expect(res.statusCode).toBe(400);
		expect(res.json().message).toBe("That code is not valid.");
		expect(stub.passwords.size).toBe(0);
		expect(await testDb.db.selectFrom("users").select("id").execute()).toEqual([]);
		expect((await auditRows("setup.code_claimed")).map((r) => r.result)).toEqual([
			"failed",
		]);
	});

	test("an email Dex already holds rolls everything back, code included", async () => {
		const code = await issueSetupCode(testDb.db);
		await stub.dex.createPassword({
			email: "owner@example.edu",
			username: "x",
			userId: crypto.randomUUID(),
			hash: "h",
		});
		expect((await firstAccount({ ...FIRST, code })).statusCode).toBe(409);
		expect(await testDb.db.selectFrom("users").select("id").execute()).toEqual([]);
		const row = await testDb.db
			.selectFrom("setup_codes")
			.select("used_at")
			.executeTakeFirstOrThrow();
		expect(row.used_at).toBeNull();
	});

	test("is refused while an enabled administrator exists", async () => {
		await insertTestUser(testDb.db, { role: "administrator" });
		const code = await issueSetupCode(testDb.db);
		expect(await state()).toBe(false);
		expect((await firstAccount({ ...FIRST, code })).statusCode).toBe(404);
		expect(stub.passwords.size).toBe(0);
	});

	test("refuses a short password and a cross-site post", async () => {
		const code = await issueSetupCode(testDb.db);
		expect((await firstAccount({ ...FIRST, password: "short", code })).statusCode).toBe(
			400,
		);
		const crossSite = await app.inject({
			method: "POST",
			url: "/setup/first-account",
			headers: { origin: "https://evil.example" },
			payload: { ...FIRST, code },
		});
		expect(crossSite.statusCode).toBe(403);
		expect(stub.passwords.size).toBe(0);
	});

	test("is throttled with the claim's limit", async () => {
		for (let i = 0; i < 10; i++) {
			await firstAccount({ ...FIRST, code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" });
		}
		const code = await issueSetupCode(testDb.db);
		expect((await firstAccount({ ...FIRST, code })).statusCode).toBe(429);
	});
});

describe.skipIf(skip)("the first-account form without Dex", () => {
	beforeEach(() => start({ dex: false }));

	test("is never offered and answers 404", async () => {
		expect(await state()).toBe(false);
		const code = await issueSetupCode(testDb.db);
		expect((await firstAccount({ ...FIRST, code })).statusCode).toBe(404);
	});
});

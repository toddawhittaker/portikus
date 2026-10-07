import { type MockOidcProvider, startMockOidcProvider } from "@portikus/auth/testing";
import type { Database } from "@portikus/db";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createSigninThrottle } from "./signin-throttle.js";
import { buildTestServer, PUBLIC_URL } from "./testing/test-support.js";

/** The sign-in rate limit (SPEC.md section 5.3). */

const skip = !hasTestDb();

function fixture(db: Kysely<Database>) {
	let clock = 1_000_000;
	const throttle = createSigninThrottle({
		db,
		logger: collectingLogger("debug").logger,
		startLimitPerMinute: 150,
		passwordLimitPer10Minutes: 30,
		now: () => clock,
	});
	return { throttle, advance: (ms: number) => (clock += ms) };
}

// Sign-in starts stay in this process, so these need no database (ADR 0053).
describe("sign-in starts", () => {
	const noDb = {} as Kysely<Database>;

	test("lets a lab of 30 sign in at five starts each, refuses the 151st start, and only for that address", () => {
		const { throttle } = fixture(noDb);
		for (let i = 0; i < 150; i += 1)
			expect(throttle.checkStart("198.51.100.1").allowed).toBe(true);
		expect(throttle.checkStart("198.51.100.1").allowed).toBe(false);
		expect(throttle.checkStart("198.51.100.2").allowed).toBe(true);
	});

	test("a new minute starts a new window", () => {
		const { throttle, advance } = fixture(noDb);
		for (let i = 0; i < 151; i += 1) throttle.checkStart("198.51.100.1");
		advance(60_000);
		expect(throttle.checkStart("198.51.100.1").allowed).toBe(true);
	});

	test("asks for an audit row once per address per window", () => {
		const { throttle, advance } = fixture(noDb);
		for (let i = 0; i < 150; i += 1) throttle.checkStart("198.51.100.1");
		expect(throttle.checkStart("198.51.100.1")).toMatchObject({
			allowed: false,
			firstRefusal: true,
		});
		expect(throttle.checkStart("198.51.100.1")).toMatchObject({
			allowed: false,
			firstRefusal: false,
		});
		advance(60_000);
		for (let i = 0; i < 150; i += 1) throttle.checkStart("198.51.100.1");
		expect(throttle.checkStart("198.51.100.1")).toMatchObject({
			allowed: false,
			firstRefusal: true,
		});
	});
});

describe.skipIf(skip)("password guesses, counted in PostgreSQL", () => {
	let t: TestDb;

	beforeAll(async () => {
		t = await createTestDb();
	});

	afterAll(async () => {
		await t.close();
	});

	beforeEach(async () => {
		await t.truncate();
	});

	async function allowed(decision: Promise<{ allowed: boolean }>): Promise<boolean> {
		return (await decision).allowed;
	}

	test("refuses the 31st password attempt in ten minutes from one address", async () => {
		const { throttle, advance } = fixture(t.db);
		for (let i = 0; i < 30; i += 1)
			expect(await allowed(throttle.passwordAttempt("198.51.100.1"))).toBe(true);
		expect(await allowed(throttle.passwordAttempt("198.51.100.1"))).toBe(false);
		advance(9 * 60_000);
		expect(await allowed(throttle.passwordAttempt("198.51.100.1"))).toBe(false);
		advance(60_000);
		expect(await allowed(throttle.passwordAttempt("198.51.100.1"))).toBe(true);
	});

	test("other clients' failures never refuse a fresh client (SPEC.md 24.13)", async () => {
		const { throttle } = fixture(t.db);
		// A hundred addresses each use up their allowance.
		await Promise.all(
			Array.from({ length: 100 }, async (_, a) => {
				for (let i = 0; i < 31; i += 1) await throttle.passwordAttempt(`10.0.${a}.1`);
			}),
		);
		expect(await allowed(throttle.passwordAttempt("203.0.113.99"))).toBe(true);
		expect(await allowed(throttle.accountAttempt("fresh@example.edu"))).toBe(true);
	});

	test("an IPv6 /64 counts as one address; the next /64 is apart", async () => {
		const { throttle } = fixture(t.db);
		for (let i = 0; i < 30; i += 1) {
			expect(
				await allowed(
					throttle.passwordAttempt(`2001:db8:1:2::${(i + 1).toString(16)}`),
				),
			).toBe(true);
		}
		expect(
			await allowed(throttle.passwordAttempt("2001:db8:1:2:ffff:ffff:ffff:ffff")),
		).toBe(false);
		expect(await allowed(throttle.passwordAttempt("2001:db8:1:3::1"))).toBe(true);
	});

	test("counts tries per account, without case, and refuses the eleventh", async () => {
		const { throttle, advance } = fixture(t.db);
		for (let i = 0; i < 10; i += 1) {
			const login = i % 2 ? "alice@example.edu" : "ALICE@example.edu";
			expect(await allowed(throttle.accountAttempt(login))).toBe(true);
		}
		expect(await throttle.accountAttempt("alice@example.edu")).toEqual({
			allowed: false,
			audit: true,
			receipt: null,
		});
		expect((await throttle.accountAttempt("alice@example.edu")).audit).toBe(false);
		expect(await allowed(throttle.accountAttempt("bob@example.edu"))).toBe(true);
		advance(10 * 60_000);
		expect(await allowed(throttle.accountAttempt("alice@example.edu"))).toBe(true);
	});

	test("a try given back does not count toward the account limit", async () => {
		const { throttle } = fixture(t.db);
		for (let i = 0; i < 50; i += 1) {
			const decision = await throttle.accountAttempt("alice@example.edu");
			expect(decision.allowed).toBe(true);
			if (decision.receipt) await throttle.giveBack(decision.receipt);
		}
		await throttle.accountFailed("alice@example.edu");
		for (let i = 0; i < 9; i += 1) await throttle.accountAttempt("alice@example.edu");
		expect(await allowed(throttle.accountAttempt("alice@example.edu"))).toBe(false);
	});

	test("right passwords given back never fill an address's limit (SPEC.md 24.13)", async () => {
		const { throttle } = fixture(t.db);
		for (let i = 0; i < 100; i += 1) {
			const decision = await throttle.passwordAttempt("198.51.100.1");
			expect(decision.allowed).toBe(true);
			if (decision.receipt) await throttle.giveBack(decision.receipt);
		}
	});

	test("an address receipt gives back the address count, not the account's", async () => {
		const { throttle } = fixture(t.db);
		const post = await throttle.passwordAttempt("198.51.100.1");
		const account = await throttle.accountAttempt("198.51.100.1");
		if (!post.receipt || !account.receipt) throw new Error("expected receipts");
		await throttle.giveBack(post.receipt);
		const rows = await t.db
			.selectFrom("signin_counters")
			.select(["scope", "count"])
			.orderBy("scope")
			.execute();
		expect(rows).toEqual([
			{ scope: "password", count: 0 },
			{ scope: "password-account", count: 1 },
		]);
	});

	test("a restart keeps the counts: a new throttle on the same database still refuses", async () => {
		const before = fixture(t.db).throttle;
		for (let i = 0; i < 30; i += 1) await before.passwordAttempt("198.51.100.1");
		const after = fixture(t.db).throttle;
		expect(await allowed(after.passwordAttempt("198.51.100.1"))).toBe(false);
	});

	test("one address making 400 password attempts does not stop another address", async () => {
		const { throttle } = fixture(t.db);
		await Promise.all(
			Array.from({ length: 400 }, () => throttle.passwordAttempt("198.51.100.1")),
		);
		expect(await allowed(throttle.passwordAttempt("198.51.100.2"))).toBe(true);
	});

	test("password attempts and sign-in starts are counted apart", async () => {
		const { throttle } = fixture(t.db);
		for (let i = 0; i < 30; i += 1) await throttle.passwordAttempt("198.51.100.1");
		expect(throttle.checkStart("198.51.100.1").allowed).toBe(true);
	});
});

describe.skipIf(skip)("the API's sign-in throttle", () => {
	let testDb: TestDb;
	let mock: MockOidcProvider;
	let app: FastifyInstance;

	beforeAll(async () => {
		testDb = await createTestDb();
		mock = await startMockOidcProvider({
			redirectUris: [`${PUBLIC_URL}/auth/callback`],
		});
	});

	afterAll(async () => {
		await testDb.close();
		await mock.close();
	});

	beforeEach(async () => {
		await testDb.truncate();
		app = buildTestServer(testDb.db, mock.issuer);
		await app.ready();
		return () => app.close();
	});

	async function throttledRows() {
		return testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "auth.throttled")
			.execute();
	}

	test("the 151st GET /auth/login in a minute is 429 RATE_LIMITED; another address is unaffected", async () => {
		for (let i = 0; i < 150; i += 1) {
			const res = await app.inject({
				url: "/auth/login",
				remoteAddress: "203.0.113.7",
			});
			expect(res.statusCode).toBe(302);
		}
		const refused = await app.inject({
			url: "/auth/login",
			remoteAddress: "203.0.113.7",
		});
		expect(refused.statusCode).toBe(429);
		expect(refused.json()).toMatchObject({ code: "RATE_LIMITED" });
		await app.inject({ url: "/auth/login", remoteAddress: "203.0.113.7" });

		const other = await app.inject({
			url: "/auth/login",
			remoteAddress: "203.0.113.8",
		});
		expect(other.statusCode).toBe(302);

		const rows = await throttledRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.result).toBe("denied");
		expect(rows[0]?.metadata).toMatchObject({
			ip: "203.0.113.7",
			scope: "signin-start",
		});
	});

	test("only /auth/login and /lti/login count as sign-in starts", async () => {
		for (let i = 0; i < 149; i += 1) {
			await app.inject({ url: "/auth/login", remoteAddress: "203.0.113.9" });
		}
		// The callback, the LTI launch and Dex's page asks are not starts.
		const callback = await app.inject({
			url: "/auth/callback",
			remoteAddress: "203.0.113.9",
		});
		expect(callback.statusCode).not.toBe(429);
		const launch = await app.inject({
			method: "POST",
			url: "/lti/launch",
			remoteAddress: "203.0.113.9",
		});
		expect(launch.statusCode).not.toBe(429);
		const ask = await app.inject({
			url: "/edge/signin-throttle?scope=start",
			headers: { "x-forwarded-for": "203.0.113.9" },
		});
		expect(ask.statusCode).toBe(204);

		const login = await app.inject({ url: "/lti/login", remoteAddress: "203.0.113.9" });
		expect(login.statusCode).not.toBe(429);
		const refused = await app.inject({
			url: "/auth/login",
			remoteAddress: "203.0.113.9",
		});
		expect(refused.statusCode).toBe(429);
	});

	function dexAsk(address: string, uri: string) {
		return app.inject({
			url: "/edge/signin-throttle?scope=start",
			headers: { "x-forwarded-for": address, "x-forwarded-uri": uri },
		});
	}

	test("the 151st GET /dex/auth from one address in a minute is 429; another address is unaffected", async () => {
		for (let i = 0; i < 150; i += 1) {
			expect((await dexAsk("203.0.113.20", `/dex/auth?state=${i}`)).statusCode).toBe(
				204,
			);
		}
		const refused = await dexAsk("203.0.113.20", "/dex/auth?state=x");
		expect(refused.statusCode).toBe(429);
		expect(refused.json()).toMatchObject({ code: "RATE_LIMITED" });
		expect((await dexAsk("203.0.113.21", "/dex/auth")).statusCode).toBe(204);
		expect(await throttledRows()).toHaveLength(1);
	});

	test("only the exact /dex/auth path is counted, so Dex's later pages in one sign-in are not", async () => {
		for (let i = 0; i < 150; i += 1) await dexAsk("203.0.113.22", "/dex/auth");
		expect((await dexAsk("203.0.113.22", "/dex/auth/local")).statusCode).toBe(204);
		expect(
			(await dexAsk("203.0.113.22", "/dex/auth/local/login?back=")).statusCode,
		).toBe(204);
		expect((await dexAsk("203.0.113.22", "/dex/auth")).statusCode).toBe(429);
	});

	test("/edge/signin-throttle answers only a loopback peer", async () => {
		const res = await app.inject({
			url: "/edge/signin-throttle",
			remoteAddress: "203.0.113.7",
			headers: { "x-forwarded-uri": "/dex/auth/local/login" },
		});
		expect(res.statusCode).toBe(403);
	});
});

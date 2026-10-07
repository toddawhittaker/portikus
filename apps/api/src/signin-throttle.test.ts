import { type MockOidcProvider, startMockOidcProvider } from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createSigninThrottle } from "./signin-throttle.js";
import { buildTestServer, PUBLIC_URL } from "./testing/test-support.js";

/** The sign-in rate limit (SPEC.md section 5.3). */

describe("createSigninThrottle", () => {
	function fixture() {
		let clock = 1_000_000;
		const throttle = createSigninThrottle({
			startLimitPerMinute: 150,
			passwordLimitPer10Minutes: 30,
			now: () => clock,
		});
		return { throttle, advance: (ms: number) => (clock += ms) };
	}

	test("lets a lab of 30 sign in at five starts each, refuses the 151st start, and only for that address", () => {
		const { throttle } = fixture();
		for (let i = 0; i < 150; i += 1)
			expect(throttle.checkStart("198.51.100.1").allowed).toBe(true);
		expect(throttle.checkStart("198.51.100.1").allowed).toBe(false);
		expect(throttle.checkStart("198.51.100.2").allowed).toBe(true);
	});

	test("a new minute starts a new window", () => {
		const { throttle, advance } = fixture();
		for (let i = 0; i < 151; i += 1) throttle.checkStart("198.51.100.1");
		advance(60_000);
		expect(throttle.checkStart("198.51.100.1").allowed).toBe(true);
	});

	test("asks for an audit row once per address per window", () => {
		const { throttle, advance } = fixture();
		for (let i = 0; i < 150; i += 1) throttle.checkStart("198.51.100.1");
		expect(throttle.checkStart("198.51.100.1")).toEqual({
			allowed: false,
			audit: true,
		});
		expect(throttle.checkStart("198.51.100.1")).toEqual({
			allowed: false,
			audit: false,
		});
		advance(60_000);
		for (let i = 0; i < 150; i += 1) throttle.checkStart("198.51.100.1");
		expect(throttle.checkStart("198.51.100.1")).toEqual({
			allowed: false,
			audit: true,
		});
	});

	test("refuses the 31st password attempt in ten minutes from one address", () => {
		const { throttle, advance } = fixture();
		for (let i = 0; i < 30; i += 1)
			expect(throttle.passwordAttempt("198.51.100.1").allowed).toBe(true);
		expect(throttle.passwordAttempt("198.51.100.1").allowed).toBe(false);
		advance(9 * 60_000);
		expect(throttle.passwordAttempt("198.51.100.1").allowed).toBe(false);
		advance(60_000);
		expect(throttle.passwordAttempt("198.51.100.1").allowed).toBe(true);
	});

	test("other clients' failures never refuse a fresh client (SPEC.md 24.13)", () => {
		const { throttle } = fixture();
		// A thousand addresses each use up their allowance.
		for (let a = 0; a < 1000; a += 1) {
			for (let i = 0; i < 31; i += 1)
				throttle.passwordAttempt(`10.${a >> 8}.${a & 255}.1`);
		}
		expect(throttle.passwordAttempt("203.0.113.99").allowed).toBe(true);
		expect(throttle.accountAttempt("fresh@example.edu").allowed).toBe(true);
	});

	test("an IPv6 /64 counts as one address; the next /64 is apart", () => {
		const { throttle } = fixture();
		for (let i = 0; i < 30; i += 1) {
			expect(
				throttle.passwordAttempt(`2001:db8:1:2::${(i + 1).toString(16)}`).allowed,
			).toBe(true);
		}
		expect(throttle.passwordAttempt("2001:db8:1:2:ffff:ffff:ffff:ffff").allowed).toBe(
			false,
		);
		expect(throttle.passwordAttempt("2001:db8:1:3::1").allowed).toBe(true);
	});

	test("counts tries per account, without case, and refuses the eleventh", () => {
		const { throttle, advance } = fixture();
		for (let i = 0; i < 10; i += 1) {
			const login = i % 2 ? "alice@example.edu" : "ALICE@example.edu";
			expect(throttle.accountAttempt(login).allowed).toBe(true);
		}
		expect(throttle.accountAttempt("alice@example.edu")).toEqual({
			allowed: false,
			audit: true,
		});
		expect(throttle.accountAttempt("alice@example.edu").audit).toBe(false);
		expect(throttle.accountAttempt("bob@example.edu").allowed).toBe(true);
		advance(10 * 60_000);
		expect(throttle.accountAttempt("alice@example.edu").allowed).toBe(true);
	});

	test("a try given back does not count toward the account limit", () => {
		const { throttle } = fixture();
		for (let i = 0; i < 50; i += 1) {
			expect(throttle.accountAttempt("alice@example.edu").allowed).toBe(true);
			throttle.accountGiveBack("alice@example.edu");
		}
		throttle.accountFailed("alice@example.edu");
		for (let i = 0; i < 9; i += 1) throttle.accountAttempt("alice@example.edu");
		expect(throttle.accountAttempt("alice@example.edu").allowed).toBe(false);
	});

	test("right passwords given back never fill an address's limit (SPEC.md 24.13)", () => {
		const { throttle } = fixture();
		for (let i = 0; i < 100; i += 1) {
			expect(throttle.passwordAttempt("198.51.100.1").allowed).toBe(true);
			throttle.passwordGiveBack("198.51.100.1");
		}
	});

	test("one address making 400 password attempts does not stop another address", () => {
		const { throttle } = fixture();
		for (let i = 0; i < 400; i += 1) throttle.passwordAttempt("198.51.100.1");
		expect(throttle.passwordAttempt("198.51.100.2").allowed).toBe(true);
	});

	test("password attempts and sign-in starts are counted apart", () => {
		const { throttle } = fixture();
		for (let i = 0; i < 30; i += 1) throttle.passwordAttempt("198.51.100.1");
		expect(throttle.checkStart("198.51.100.1").allowed).toBe(true);
	});
});

const skip = !hasTestDb();

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

	test("/edge/signin-throttle answers only a loopback peer", async () => {
		const res = await app.inject({
			url: "/edge/signin-throttle",
			remoteAddress: "203.0.113.7",
			headers: { "x-forwarded-uri": "/dex/auth/local/login" },
		});
		expect(res.statusCode).toBe(403);
	});
});

import { type MockOidcProvider, startMockOidcProvider } from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createSigninThrottle } from "./signin-throttle.js";
import { buildTestServer, PUBLIC_URL } from "./test-support.js";

/** The sign-in rate limit (issue #398; docs/EPIC-12B.md, "Sign-in rate limit"). */

describe("createSigninThrottle", () => {
	function fixture() {
		let clock = 1_000_000;
		const throttle = createSigninThrottle({
			startLimitPerMinute: 60,
			passwordLimitPer10Minutes: 30,
			now: () => clock,
		});
		return { throttle, advance: (ms: number) => (clock += ms) };
	}

	test("refuses the 61st sign-in start in a minute, and only for that address", () => {
		const { throttle } = fixture();
		for (let i = 0; i < 60; i += 1)
			expect(throttle.checkStart("198.51.100.1").allowed).toBe(true);
		expect(throttle.checkStart("198.51.100.1").allowed).toBe(false);
		expect(throttle.checkStart("198.51.100.2").allowed).toBe(true);
	});

	test("a new minute starts a new window", () => {
		const { throttle, advance } = fixture();
		for (let i = 0; i < 61; i += 1) throttle.checkStart("198.51.100.1");
		advance(60_000);
		expect(throttle.checkStart("198.51.100.1").allowed).toBe(true);
	});

	test("asks for an audit row once per address per window", () => {
		const { throttle, advance } = fixture();
		for (let i = 0; i < 60; i += 1) throttle.checkStart("198.51.100.1");
		expect(throttle.checkStart("198.51.100.1")).toEqual({
			allowed: false,
			audit: true,
		});
		expect(throttle.checkStart("198.51.100.1")).toEqual({
			allowed: false,
			audit: false,
		});
		advance(60_000);
		for (let i = 0; i < 60; i += 1) throttle.checkStart("198.51.100.1");
		expect(throttle.checkStart("198.51.100.1")).toEqual({
			allowed: false,
			audit: true,
		});
	});

	test("refuses the 31st password attempt in ten minutes from one address", () => {
		const { throttle, advance } = fixture();
		for (let i = 0; i < 30; i += 1)
			expect(throttle.checkPassword("198.51.100.1").allowed).toBe(true);
		expect(throttle.checkPassword("198.51.100.1").allowed).toBe(false);
		advance(9 * 60_000);
		expect(throttle.checkPassword("198.51.100.1").allowed).toBe(false);
		advance(60_000);
		expect(throttle.checkPassword("198.51.100.1").allowed).toBe(true);
	});

	test("refuses every address once 300 password attempts arrive in ten minutes", () => {
		const { throttle } = fixture();
		for (let i = 0; i < 300; i += 1) {
			expect(throttle.checkPassword(`198.51.100.${i % 20}`).allowed).toBe(true);
		}
		expect(throttle.checkPassword("203.0.113.99")).toEqual({
			allowed: false,
			audit: true,
		});
	});

	test("password attempts and sign-in starts are counted apart", () => {
		const { throttle } = fixture();
		for (let i = 0; i < 30; i += 1) throttle.checkPassword("198.51.100.1");
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

	test("the 61st GET /auth/login in a minute is 429 RATE_LIMITED; another address is unaffected", async () => {
		for (let i = 0; i < 60; i += 1) {
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

	test("/auth/callback shares the sign-in start limit", async () => {
		for (let i = 0; i < 60; i += 1) {
			await app.inject({ url: "/auth/login", remoteAddress: "203.0.113.7" });
		}
		const res = await app.inject({
			url: "/auth/callback",
			remoteAddress: "203.0.113.7",
		});
		expect(res.statusCode).toBe(429);
	});

	function edgeCheck(clientIp: string, uri = "/dex/auth/local/login?back=&state=x") {
		return app.inject({
			url: "/edge/signin-throttle",
			headers: { "x-forwarded-for": clientIp, "x-forwarded-uri": uri },
		});
	}

	test("/edge/signin-throttle refuses the 31st password check in ten minutes", async () => {
		for (let i = 0; i < 30; i += 1) {
			expect((await edgeCheck("192.0.2.10")).statusCode).toBe(204);
		}
		const refused = await edgeCheck("192.0.2.10");
		expect(refused.statusCode).toBe(429);
		expect(refused.json()).toMatchObject({ code: "RATE_LIMITED" });
		expect((await edgeCheck("192.0.2.11")).statusCode).toBe(204);

		const rows = await throttledRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.metadata).toMatchObject({ ip: "192.0.2.10", scope: "password" });
	});

	test("/edge/signin-throttle does not count a URI outside the password form", async () => {
		for (let i = 0; i < 40; i += 1) {
			expect((await edgeCheck("192.0.2.10", "/dex/auth")).statusCode).toBe(204);
		}
		expect((await edgeCheck("192.0.2.10")).statusCode).toBe(204);
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

import { type MockOidcProvider, startMockOidcProvider } from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createSigninThrottle } from "./signin-throttle.js";
import { buildTestServer, PUBLIC_URL } from "./test-support.js";

/** The sign-in rate limit (issue #398; docs/archive/epics/EPIC-12B.md, "Sign-in rate limit"). */

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

	test("one address making 400 password attempts does not stop another address", () => {
		const { throttle } = fixture();
		for (let i = 0; i < 400; i += 1) throttle.checkPassword("198.51.100.1");
		expect(throttle.checkPassword("198.51.100.2").allowed).toBe(true);
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

	test("/auth/callback shares the sign-in start limit", async () => {
		for (let i = 0; i < 150; i += 1) {
			await app.inject({ url: "/auth/login", remoteAddress: "203.0.113.7" });
		}
		const res = await app.inject({
			url: "/auth/callback",
			remoteAddress: "203.0.113.7",
		});
		expect(res.statusCode).toBe(429);
	});

	test("/lti/login and /lti/launch share the sign-in start limit", async () => {
		for (let i = 0; i < 149; i += 1) {
			await app.inject({ url: "/auth/login", remoteAddress: "203.0.113.9" });
		}
		const login = await app.inject({ url: "/lti/login", remoteAddress: "203.0.113.9" });
		expect(login.statusCode).not.toBe(429);
		const launch = await app.inject({
			method: "POST",
			url: "/lti/launch",
			remoteAddress: "203.0.113.9",
		});
		expect(launch.statusCode).toBe(429);
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

	test("/edge/signin-throttle counts every check, even with an encoded password-form URI", async () => {
		// Caddy matched the decoded path already; the raw URI can differ.
		for (let i = 0; i < 30; i += 1) {
			const uri = i % 2 ? "/dex/auth/loc%61l/login?state=x" : "/dex/auth/%6cocal/login";
			expect((await edgeCheck("192.0.2.10", uri)).statusCode).toBe(204);
		}
		expect((await edgeCheck("192.0.2.10", "/dex/auth/loc%61l/login")).statusCode).toBe(
			429,
		);
		expect((await edgeCheck("192.0.2.10")).statusCode).toBe(429);
	});

	test("/edge/signin-throttle: one address's 400 checks do not lock out another", async () => {
		for (let i = 0; i < 400; i += 1) await edgeCheck("192.0.2.10");
		expect((await edgeCheck("192.0.2.11")).statusCode).toBe(204);
	});

	test("/edge/signin-throttle?scope=start counts a sign-in start, shared with /auth/login", async () => {
		const start = (ip: string) =>
			app.inject({
				url: "/edge/signin-throttle?scope=start",
				headers: {
					"x-forwarded-for": ip,
					"x-forwarded-uri": "/dex/auth/local?state=x",
				},
			});
		for (let i = 0; i < 75; i += 1) {
			await app.inject({ url: "/auth/login", remoteAddress: "192.0.2.20" });
		}
		for (let i = 0; i < 75; i += 1) {
			expect((await start("192.0.2.20")).statusCode).toBe(204);
		}
		const refused = await start("192.0.2.20");
		expect(refused.statusCode).toBe(429);
		expect(refused.json()).toMatchObject({ code: "RATE_LIMITED" });
		// A start is not a password attempt.
		expect((await edgeCheck("192.0.2.20")).statusCode).toBe(204);

		const rows = await throttledRows();
		expect(rows[0]?.metadata).toMatchObject({
			ip: "192.0.2.20",
			scope: "signin-start",
		});
	});

	test("/edge/signin-throttle counts anything but exactly scope=start as a password attempt", async () => {
		const ask = (query: string) =>
			app.inject({
				url: `/edge/signin-throttle?${query}`,
				headers: { "x-forwarded-for": "192.0.2.30" },
			});
		const queries = [
			"scope=password",
			"scope=Start",
			"scope=start&scope=start",
			"scope=",
		];
		for (let i = 0; i < 30; i += 1) {
			expect((await ask(queries[i % queries.length] ?? "")).statusCode).toBe(204);
		}
		expect((await ask("scope=password")).statusCode).toBe(429);
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

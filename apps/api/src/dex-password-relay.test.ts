import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type MockOidcProvider, startMockOidcProvider } from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { dexOutcome } from "./dex-password-relay.js";
import { PAGE_POLICY } from "./page-policy.js";
import { ACCOUNT_FAILURE_LIMIT } from "./signin-throttle.js";
import { buildTestServer, PUBLIC_URL } from "./testing/test-support.js";

/** Dex's password posts, counted and audited by the API (SPEC.md section 24.13). */

const RIGHT = "right-password-for-the-test";
const WRONG = "wrong-password-for-the-test";

test("a redirect from Dex is a success and a re-rendered form a failure", () => {
	expect(dexOutcome(303)).toBe("success");
	expect(dexOutcome(302)).toBe("success");
	expect(dexOutcome(200)).toBe("failure");
	expect(dexOutcome(401)).toBe("failure");
	expect(dexOutcome(500)).toBe("other");
	expect(dexOutcome(400)).toBe("other");
});

const skip = !hasTestDb();

describe.skipIf(skip)("the Dex password relay", () => {
	let testDb: TestDb;
	let mock: MockOidcProvider;
	let dex: Server;
	let dexUrl: string;
	let received: { url: string; body: string }[];
	let app: FastifyInstance;
	let lines: Record<string, unknown>[];

	beforeAll(async () => {
		testDb = await createTestDb();
		mock = await startMockOidcProvider({
			redirectUris: [`${PUBLIC_URL}/auth/callback`],
		});
		// Stands in for Dex's password form: a redirect when right, the form again when wrong.
		dex = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", () => {
				received.push({ url: req.url ?? "", body });
				if (new URLSearchParams(body).get("password") === RIGHT) {
					res.writeHead(303, {
						location: "/dex/approval?req=abc",
						"set-cookie": "dex_state=1; Path=/dex",
					});
					res.end();
					return;
				}
				res.writeHead(200, { "content-type": "text/html" });
				res.end("<p>Invalid Email Address and password.</p>");
			});
		});
		await new Promise<void>((resolve) => dex.listen(0, "127.0.0.1", resolve));
		dexUrl = `http://127.0.0.1:${(dex.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		await testDb.close();
		await mock.close();
		await new Promise((resolve) => dex.close(resolve));
	});

	beforeEach(async () => {
		await testDb.truncate();
		received = [];
		const collected = collectingLogger("debug");
		lines = collected.lines;
		app = buildTestServer(
			testDb.db,
			mock.issuer,
			{ DEX_HTTP_URL: dexUrl },
			collected.logger,
		);
		await app.ready();
		return () => app.close();
	});

	function post(
		login: string,
		password: string,
		options: { ip?: string; cookie?: string; path?: string } = {},
	) {
		return app.inject({
			method: "POST",
			url: options.path ?? "/dex/auth/local/login?back=&state=s1",
			headers: {
				origin: PUBLIC_URL,
				"content-type": "application/x-www-form-urlencoded",
				"x-forwarded-for": options.ip ?? "198.51.100.1",
				...(options.cookie ? { cookie: options.cookie } : {}),
			},
			payload: new URLSearchParams({ login, password }).toString(),
		});
	}

	async function auditRows(action: string) {
		return testDb.db
			.selectFrom("audit_events")
			.select(["actor", "target", "result", "metadata"])
			.where("action", "=", action)
			.execute();
	}

	test("a right password passes Dex's redirect through and marks the browser as known", async () => {
		const res = await post("alice@example.edu", RIGHT);
		expect(res.statusCode).toBe(303);
		expect(res.headers.location).toBe("/dex/approval?req=abc");
		const cookies = [res.headers["set-cookie"]].flat().join("\n");
		expect(cookies).toContain("dex_state=1");
		expect(cookies).toMatch(/portikus_known_device=[^;]+;.*HttpOnly/);
		expect(cookies).toContain("SameSite=Lax");
		// The path, query and form reached Dex as sent.
		expect(received).toEqual([
			{
				url: "/dex/auth/local/login?back=&state=s1",
				body: new URLSearchParams({
					login: "alice@example.edu",
					password: RIGHT,
				}).toString(),
			},
		]);
		expect(await auditRows("auth.password_failed")).toEqual([]);
	});

	test("a wrong password returns Dex's page and writes an audit row without the password", async () => {
		const res = await post("Alice@Example.edu", WRONG);
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain("Invalid Email Address and password.");
		// Dex's page loads its own stylesheet, font and script; the API's page policy would block them.
		expect(res.headers["content-security-policy"]).toBeUndefined();
		const rows = await auditRows("auth.password_failed");
		expect(rows).toEqual([
			{
				actor: "unknown",
				target: "login:alice@example.edu",
				result: "failed",
				metadata: { ip: "198.51.100.1" },
			},
		]);
		const everything = JSON.stringify([rows, lines]);
		expect(everything).not.toContain(WRONG);
	});

	test("refuses an account after its tenth wrong password, from any new address, with a clear page", async () => {
		for (let i = 0; i < ACCOUNT_FAILURE_LIMIT; i += 1) {
			expect(
				(await post("alice@example.edu", WRONG, { ip: `203.0.113.${i}` })).statusCode,
			).toBe(200);
		}
		const refused = await post("alice@example.edu", RIGHT, { ip: "192.0.2.50" });
		expect(refused.statusCode).toBe(429);
		expect(refused.headers["content-type"]).toContain("text/html");
		expect(refused.body).toContain("Too many sign-in attempts");
		expect(refused.headers["content-security-policy"]).toBe(PAGE_POLICY);
		// Dex never saw the refused try.
		expect(received).toHaveLength(ACCOUNT_FAILURE_LIMIT);
		// Another account from the same address is unaffected.
		expect(
			(await post("bob@example.edu", RIGHT, { ip: "192.0.2.50" })).statusCode,
		).toBe(303);

		const throttled = await auditRows("auth.throttled");
		expect(throttled).toEqual([
			{
				actor: "unknown",
				target: "login:alice@example.edu",
				result: "denied",
				metadata: { ip: "192.0.2.50", scope: "password-account" },
			},
		]);
	});

	test("a browser the account signed in on before is not refused for others' wrong passwords", async () => {
		const first = await post("alice@example.edu", RIGHT);
		const known = [first.headers["set-cookie"]]
			.flat()
			.map(String)
			.find((c) => c.startsWith("portikus_known_device="))
			?.split(";")[0];
		expect(known).toBeDefined();
		for (let i = 0; i < ACCOUNT_FAILURE_LIMIT; i += 1) {
			await post("alice@example.edu", WRONG, { ip: `203.0.113.${i}` });
		}
		expect(
			(await post("alice@example.edu", RIGHT, { ip: "192.0.2.60" })).statusCode,
		).toBe(429);
		const res = await post("alice@example.edu", RIGHT, {
			ip: "192.0.2.60",
			cookie: known as string,
		});
		expect(res.statusCode).toBe(303);
		// The cookie is for alice only.
		for (let i = 0; i < ACCOUNT_FAILURE_LIMIT; i += 1) {
			await post("bob@example.edu", WRONG, { ip: `203.0.113.${i}` });
		}
		expect(
			(
				await post("bob@example.edu", RIGHT, {
					ip: "192.0.2.60",
					cookie: known as string,
				})
			).statusCode,
		).toBe(429);
	});

	test("counts wrong passwords per address, the IPv6 /64 as one", async () => {
		for (let i = 0; i < 30; i += 1) {
			await post(`user${i}@example.edu`, WRONG, { ip: `2001:db8:5:6::${i + 1}` });
		}
		const refused = await post("new@example.edu", RIGHT, {
			ip: "2001:db8:5:6:a:b:c:d",
		});
		expect(refused.statusCode).toBe(429);
		expect(
			(await post("new@example.edu", RIGHT, { ip: "2001:db8:5:7::1" })).statusCode,
		).toBe(303);
	});

	test("parallel guesses cannot pass the account limit: each is counted before Dex sees it", async () => {
		const results = await Promise.all(
			Array.from({ length: 40 }, (_, i) =>
				post("alice@example.edu", WRONG, { ip: `203.0.113.${i}` }),
			),
		);
		expect(received.length).toBeLessThanOrEqual(ACCOUNT_FAILURE_LIMIT);
		expect(results.filter((r) => r.statusCode === 429).length).toBeGreaterThanOrEqual(
			40 - ACCOUNT_FAILURE_LIMIT,
		);
	});

	test("the address count survives a restart of the API (ADR 0053)", async () => {
		for (let i = 0; i < 30; i += 1) {
			await post(`user${i}@example.edu`, WRONG, { ip: "198.51.100.30" });
		}
		await app.close();
		app = buildTestServer(testDb.db, mock.issuer, { DEX_HTTP_URL: dexUrl });
		await app.ready();
		const refused = await post("fresh@example.edu", WRONG, { ip: "198.51.100.30" });
		expect(refused.statusCode).toBe(429);
		expect(received).toHaveLength(30);
	});

	test("when Dex does not answer, the relay's own 502 page carries the page policy", async () => {
		await app.close();
		// Port 9 (discard) has no listener here, so the fetch is refused.
		app = buildTestServer(testDb.db, mock.issuer, {
			DEX_HTTP_URL: "http://127.0.0.1:9",
		});
		await app.ready();
		const res = await post("alice@example.edu", RIGHT);
		expect(res.statusCode).toBe(502);
		expect(res.body).toContain("Sign-in is unavailable");
		expect(res.headers["content-security-policy"]).toBe(PAGE_POLICY);
	});

	test("when the counts cannot be kept, a post is refused with 503 and never reaches Dex", async () => {
		await sql`alter table signin_counters rename to signin_counters_away`.execute(
			testDb.db,
		);
		try {
			const res = await post("alice@example.edu", RIGHT);
			expect(res.statusCode).toBe(503);
			expect(res.headers["content-type"]).toContain("text/html");
			expect(res.body).toContain("Sign-in is unavailable");
			expect(res.headers["content-security-policy"]).toBe(PAGE_POLICY);
		} finally {
			await sql`alter table signin_counters_away rename to signin_counters`.execute(
				testDb.db,
			);
		}
		expect(received).toEqual([]);
		expect(lines.some((l) => l.msg === "sign-in counter store failed")).toBe(true);
	});

	test("right passwords from one address never fill its limit (SPEC.md 24.13)", async () => {
		for (let i = 0; i < 60; i += 1) {
			expect(
				(await post(`user${i}@example.edu`, RIGHT, { ip: "198.51.100.9" })).statusCode,
			).toBe(303);
		}
	});

	test("a right password gives its account try back", async () => {
		for (let i = 0; i < 30; i += 1) {
			await post("alice@example.edu", RIGHT, { ip: `203.0.113.${i}` });
		}
		expect(
			(await post("alice@example.edu", WRONG, { ip: "192.0.2.70" })).statusCode,
		).toBe(200);
	});

	test.each([
		["no login", "password=x"],
		["an empty login", "login=&password=x"],
		["a blank login", "login=%20%20&password=x"],
		["a repeated login", "login=a%40example.edu&login=b%40example.edu&password=x"],
		// Go and JavaScript lower-case "İ" differently, which would split one
		// Dex account's count in two (SPEC.md section 24.13).
		["a login that is not plain ASCII", "login=%C4%B0nci%40example.edu&password=x"],
	])("refuses a post with %s without forwarding it", async (_label, payload) => {
		const res = await app.inject({
			method: "POST",
			url: "/dex/auth/local/login?state=s1",
			headers: {
				origin: PUBLIC_URL,
				"content-type": "application/x-www-form-urlencoded",
				"x-forwarded-for": "198.51.100.1",
			},
			payload,
		});
		expect(res.statusCode).toBe(400);
		expect(res.headers["content-security-policy"]).toBe(PAGE_POLICY);
		expect(received).toEqual([]);
	});

	test("never forwards a login in the query string", async () => {
		await post("alice@example.edu", WRONG, {
			path: "/dex/auth/local/login?login=bob%40example.edu&state=s1",
		});
		expect(received[0]?.url).toBe("/dex/auth/local/login?state=s1");
	});

	const cookieFrom = (res: { headers: Record<string, unknown> }) =>
		[res.headers["set-cookie"]]
			.flat()
			.map(String)
			.find((c) => c.startsWith("portikus_known_device="))
			?.split(";")[0] as string;

	async function lockOutAlice(): Promise<void> {
		for (let i = 0; i < ACCOUNT_FAILURE_LIMIT; i += 1) {
			await post("alice@example.edu", WRONG, { ip: `203.0.113.${i}` });
		}
	}

	test("a known-device cookie lasts ninety days", async () => {
		const signedIn = await post("alice@example.edu", RIGHT);
		expect(String([signedIn.headers["set-cookie"]].flat())).toContain(
			"Max-Age=7776000",
		);
	});

	test("the server ends a known-device cookie after ninety days, even one copied elsewhere", async () => {
		const start = Date.now();
		vi.useFakeTimers({ toFake: ["Date"], now: start });
		try {
			const known = cookieFrom(await post("alice@example.edu", RIGHT));
			vi.setSystemTime(start + 89 * 86_400_000);
			await lockOutAlice();
			expect(
				(await post("alice@example.edu", RIGHT, { ip: "192.0.2.80", cookie: known }))
					.statusCode,
			).toBe(303);
			vi.setSystemTime(start + 91 * 86_400_000);
			await lockOutAlice();
			expect(
				(await post("alice@example.edu", RIGHT, { ip: "192.0.2.81", cookie: known }))
					.statusCode,
			).toBe(429);
		} finally {
			vi.useRealTimers();
		}
	});

	test.each(["dex_user.password_reset", "user.password_changed", "local_admin.reset"])(
		"%s ends earlier known-device cookies",
		async (action) => {
			const user = await testDb.db
				.insertInto("users")
				.values({
					oidc_issuer: mock.issuer,
					oidc_subject: "alice-sub",
					email: "Alice@example.edu",
					display_name: "Alice",
					role: "student",
					provider_role: "student",
				})
				.returning("id")
				.executeTakeFirstOrThrow();
			const known = cookieFrom(await post("alice@example.edu", RIGHT));
			await testDb.db
				.insertInto("audit_events")
				.values({
					actor: "unknown",
					target: user.id,
					action,
					result: "ok",
					metadata: null,
				})
				.execute();
			await lockOutAlice();
			expect(
				(await post("alice@example.edu", RIGHT, { ip: "192.0.2.80", cookie: known }))
					.statusCode,
			).toBe(429);
		},
	);

	test("the refusal page works on a phone, in light and dark, with a way back", async () => {
		for (let i = 0; i < ACCOUNT_FAILURE_LIMIT; i += 1) {
			await post("alice@example.edu", WRONG, { ip: `203.0.113.${i}` });
		}
		const res = await post("alice@example.edu", WRONG, { ip: "192.0.2.90" });
		expect(res.statusCode).toBe(429);
		expect(res.body).toContain(
			'<meta name="viewport" content="width=device-width, initial-scale=1">',
		);
		expect(res.body).toContain('<meta name="color-scheme" content="light dark">');
		expect(res.body).toContain("prefers-color-scheme: dark");
		expect(res.body).toMatch(/<a href="\/auth\/login">Back to sign in<\/a>/);
	});

	test("answers only a loopback peer", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/dex/auth/local/login",
			remoteAddress: "203.0.113.7",
			headers: {
				origin: PUBLIC_URL,
				"content-type": "application/x-www-form-urlencoded",
			},
			payload: "login=a&password=b",
		});
		expect(res.statusCode).toBe(404);
		expect(received).toEqual([]);
	});
});

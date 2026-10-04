import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type MockOidcProvider, startMockOidcProvider } from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { dexOutcome } from "./dex-password-relay.js";
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

	test("counts every post per address, the IPv6 /64 as one", async () => {
		for (let i = 0; i < 30; i += 1) {
			await post(`user${i}@example.edu`, RIGHT, { ip: `2001:db8:5:6::${i + 1}` });
		}
		const refused = await post("new@example.edu", RIGHT, {
			ip: "2001:db8:5:6:a:b:c:d",
		});
		expect(refused.statusCode).toBe(429);
		expect(
			(await post("new@example.edu", RIGHT, { ip: "2001:db8:5:7::1" })).statusCode,
		).toBe(303);
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

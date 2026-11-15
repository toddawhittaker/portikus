import { createApiKey } from "@portikus/auth";
import {
	CookieJar,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	buildTestServer,
	MATRIX_MOCK_USERS,
	PUBLIC_URL,
} from "../testing/test-support.js";

/**
 * The `/mcp` door (SPEC.md sections 24.1 and 24.8): only an API key gets in,
 * a refusal names the Bearer scheme with no OAuth metadata, and no page on
 * another origin can drive it.
 */

const skip = !hasTestDb();

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		users: MATRIX_MOCK_USERS,
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	app = buildTestServer(testDb.db, mock.issuer);
	await app.ready();
	return async () => {
		await app.close();
	};
});

const INITIALIZE = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "test", version: "1.0.0" },
	},
};

const MCP_HEADERS = {
	"content-type": "application/json",
	accept: "application/json, text/event-stream",
};

async function adminKey(): Promise<{ secret: string; jar: CookieJar }> {
	const jar = new CookieJar();
	await loginAs(app, "carol", jar);
	const me = await app.inject({
		method: "GET",
		url: "/auth/me",
		headers: { cookie: jar.cookieHeader() },
	});
	const made = await createApiKey(testDb.db, me.json().id, {
		name: "mcp",
		scope: "read",
		periodDays: 30,
	});
	if (!made.ok) throw new Error(made.reason);
	return { secret: made.secret, jar };
}

function post(headers: Record<string, string>) {
	return app.inject({
		method: "POST",
		url: "/mcp",
		headers: { ...MCP_HEADERS, ...headers },
		payload: INITIALIZE,
	});
}

describe.skipIf(skip)("/mcp", () => {
	test("a key initializes", async () => {
		const { secret } = await adminKey();
		const res = await post({ authorization: `Bearer ${secret}` });
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('"serverInfo"');
		expect(res.body).toContain('"portikus"');
	});

	test("a request with the site's own Origin is served", async () => {
		const { secret } = await adminKey();
		const res = await post({
			authorization: `Bearer ${secret}`,
			origin: new URL(PUBLIC_URL).origin,
		});
		expect(res.statusCode).toBe(200);
	});

	test.each(["https://evil.example", "http://127.0.0.1:5174", "null"])(
		"a key sent with Origin %s gets 403",
		async (origin) => {
			const { secret } = await adminKey();
			const res = await post({ authorization: `Bearer ${secret}`, origin });
			expect(res.statusCode).toBe(403);
			expect(res.body).not.toContain("serverInfo");
		},
	);

	test.each(["GET", "POST"] as const)(
		"%s with a browser session cookie gets 401 naming the Bearer scheme",
		async (method) => {
			const { jar } = await adminKey();
			const res = await app.inject({
				method,
				url: "/mcp",
				headers: {
					...MCP_HEADERS,
					cookie: jar.cookieHeader(),
					origin: new URL(PUBLIC_URL).origin,
				},
				...(method === "POST" ? { payload: INITIALIZE } : {}),
			});
			expect(res.statusCode).toBe(401);
			expect(res.headers["www-authenticate"]).toBe("Bearer");
		},
	);

	test.each([
		["no key", {}],
		["an unknown key", { authorization: "Bearer portikus_not-a-real-key" }],
		["another kind of bearer token", { authorization: "Bearer abc.def.ghi" }],
	] as const)("%s gets 401 with a plain Bearer challenge", async (_name, headers) => {
		const res = await post(headers);
		expect(res.statusCode).toBe(401);
		expect(res.headers["www-authenticate"]).toBe("Bearer");
		expect(res.body).not.toContain("resource_metadata");
	});

	test("GET with a key is answered by the MCP handler, not refused", async () => {
		const { secret } = await adminKey();
		const res = await app.inject({
			method: "GET",
			url: "/mcp",
			headers: { authorization: `Bearer ${secret}`, accept: "text/event-stream" },
		});
		expect([401, 403]).not.toContain(res.statusCode);
	});

	test("no OAuth discovery document is served", async () => {
		const { secret } = await adminKey();
		for (const url of [
			"/.well-known/oauth-protected-resource",
			"/.well-known/oauth-protected-resource/mcp",
			"/.well-known/oauth-authorization-server",
		]) {
			expect(app.hasRoute({ method: "GET", url }), url).toBe(false);
			const res = await app.inject({
				method: "GET",
				url,
				headers: { authorization: `Bearer ${secret}` },
			});
			expect(res.statusCode, url).not.toBe(200);
		}
	});
});

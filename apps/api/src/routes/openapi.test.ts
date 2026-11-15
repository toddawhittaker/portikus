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
 * `GET /openapi.json` (SPEC.md section 27): the exposed operations, for any
 * valid key or a signed-in administrator or instructor, never a student.
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

async function session(user: string): Promise<{ cookie: string; id: string }> {
	const jar = new CookieJar();
	await loginAs(app, user, jar);
	const cookie = jar.cookieHeader();
	const me = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
	return { cookie, id: me.json().id };
}

function get(headers: Record<string, string>) {
	return app.inject({ method: "GET", url: "/openapi.json", headers });
}

describe.skipIf(skip)("GET /openapi.json", () => {
	test("a key of any scope gets the document, the same each time", async () => {
		const ivy = await session("ivy");
		const made = await createApiKey(testDb.db, ivy.id, {
			name: "docs",
			scope: "read",
			periodDays: 30,
		});
		if (!made.ok) throw new Error(made.reason);
		const first = await get({ authorization: `Bearer ${made.secret}` });
		expect(first.statusCode).toBe(200);
		const doc = first.json();
		expect(doc.openapi).toBe("3.1.0");
		expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
		expect(doc.components.securitySchemes.cookieAuth.name).toBeTruthy();
		const second = await get({ authorization: `Bearer ${made.secret}` });
		expect(second.body).toBe(first.body);
	});

	test.each(["carol", "ivy"])(
		"a signed-in staff session (%s) gets the document",
		async (user) => {
			const { cookie } = await session(user);
			const res = await get({ cookie });
			expect(res.statusCode).toBe(200);
			expect(res.json().openapi).toBe("3.1.0");
		},
	);

	test("a student session gets 403", async () => {
		const { cookie } = await session("alice");
		const res = await get({ cookie });
		expect(res.statusCode).toBe(403);
		expect(res.json().code).toBe("FORBIDDEN");
	});

	test("nobody signed in gets 401", async () => {
		expect((await get({})).statusCode).toBe(401);
	});
});

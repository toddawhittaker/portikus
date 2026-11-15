import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	SoftPasskey,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

/**
 * The second-factor step inside a signed-in action (SPEC.md section 24.13).
 * A passkey challenge answers only the session and flow that asked for it,
 * and only once. The link flow's own cases are in routes/links.test.ts.
 */

const skip = !hasTestDb();

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;

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
	app = buildTestServer(testDb.db, mock.issuer);
	await app.ready();
	return async () => {
		await app.close();
	};
});

function post(jar: CookieJar, url: string, payload: object = {}) {
	return app.inject({
		method: "POST",
		url,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload,
	});
}

/** The Dex local-password administrator, enrolled with a software passkey. */
async function localAdminWithPasskey(): Promise<{ jar: CookieJar; key: SoftPasskey }> {
	const jar = new CookieJar();
	await loginAs(app, "admin", jar);
	const key = new SoftPasskey(PUBLIC_URL);
	const start = await post(jar, "/me/second-factor/webauthn/start");
	const done = await post(jar, "/me/second-factor/webauthn", {
		credential: key.register(start.json()),
		label: "Laptop",
	});
	expect(done.statusCode).toBe(200);
	await testDb.db
		.updateTable("users")
		.set({ role: "administrator", granted_role: "administrator" })
		.where("role", "<>", "administrator")
		.execute();
	return { jar, key };
}

describe.skipIf(skip)("passkey challenges per flow", () => {
	test("a challenge made in one session does not answer another", async () => {
		const { jar, key } = await localAdminWithPasskey();
		// A second session of the same account passes the sign-in gate with the passkey.
		const other = new CookieJar();
		await loginAs(app, "admin", other);
		const gate = await post(other, "/me/second-factor/webauthn/verify/start");
		const verified = await post(other, "/me/second-factor/webauthn/verify", {
			credential: key.authenticate(gate.json()),
		});
		expect(verified.statusCode).toBe(204);

		const start = await post(jar, "/me/api-keys/passkey/start");
		const res = await post(other, "/me/api-keys", {
			name: "Laptop",
			credential: key.authenticate(start.json()),
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("PASSKEY_EXPIRED");
	});

	test("a challenge is used once", async () => {
		const { jar, key } = await localAdminWithPasskey();
		const start = await post(jar, "/me/api-keys/passkey/start");
		const credential = key.authenticate(start.json());
		expect(
			(await post(jar, "/me/api-keys", { name: "One", credential })).statusCode,
		).toBe(201);
		const again = await post(jar, "/me/api-keys", { name: "Two", credential });
		expect(again.statusCode).toBe(400);
		expect(again.json().code).toBe("PASSKEY_EXPIRED");
	});
});

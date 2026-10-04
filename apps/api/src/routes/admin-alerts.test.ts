import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { TestAlertResponse } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

const skip = !hasTestDb();
let testDb: TestDb;
let mock: MockOidcProvider;
let receiver: Server;
let receiverUrl: string;
const received: unknown[] = [];

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ redirectUris: [`${PUBLIC_URL}/auth/callback`] });
	receiver = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			received.push(JSON.parse(body));
			res.end();
		});
	});
	await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
	receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
	await new Promise((r) => receiver.close(r));
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	received.length = 0;
});

async function post(app: FastifyInstance, who: string) {
	const jar = new CookieJar();
	await loginAs(app, who, jar);
	return app.inject({
		method: "POST",
		url: "/admin/alerts/test",
		headers: csrfHeaders(jar, PUBLIC_URL),
	});
}

test.skipIf(skip)("only an administrator may send a test alert", async () => {
	const app = buildTestServer(testDb.db, mock.issuer);
	await app.ready();
	try {
		expect(
			(
				await app.inject({
					method: "POST",
					url: "/admin/alerts/test",
					headers: { origin: new URL(PUBLIC_URL).origin },
				})
			).statusCode,
		).toBe(401);
		expect((await post(app, "alice")).statusCode).toBe(403);
	} finally {
		await app.close();
	}
});

test.skipIf(skip)("with no channel configured the result list is empty", async () => {
	const app = buildTestServer(testDb.db, mock.issuer);
	await app.ready();
	try {
		const res = await post(app, "carol");
		expect(res.statusCode).toBe(200);
		expect(TestAlertResponse.parse(res.json())).toEqual({ results: [] });
	} finally {
		await app.close();
	}
});

test.skipIf(skip)("a configured webhook receives the test alert", async () => {
	const app = buildTestServer(testDb.db, mock.issuer, {
		ALERT_WEBHOOK_URL: receiverUrl,
	});
	await app.ready();
	try {
		const res = await post(app, "carol");
		expect(res.json()).toEqual({ results: [{ channel: "webhook", ok: true }] });
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({
			title: "Test alert from Portikus",
			tone: "warning",
		});
		// A test alert is not a notification, so the worker never forwards it again.
		const n = await testDb.db.selectFrom("notifications").select("id").execute();
		expect(n).toEqual([]);
	} finally {
		await app.close();
	}
});

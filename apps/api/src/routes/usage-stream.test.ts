/**
 * An agent whose usage reply breaks off mid-body is answered as an unreadable
 * reply (503), not as an internal error (SPEC.md §18.2, §24.6).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

const skip = !hasTestDb();
const AGENT_TOKEN = "broken-agent-token";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: http.Server;
let app: FastifyInstance;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
	// Promises a long JSON body, sends a few bytes, then drops the connection.
	agent = http.createServer((_request, response) => {
		response.writeHead(200, {
			"content-type": "application/json",
			"content-length": "1000",
		});
		response.write('{"cpu":');
		setTimeout(() => response.destroy(), 20);
	});
	await new Promise<void>((resolve) => agent.listen(0, "127.0.0.1", resolve));
	app = buildTestServer(testDb.db, mock.issuer, {
		AGENT_PORT: (agent.address() as AddressInfo).port,
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
	if (skip) return;
	await app.close();
	agent.closeAllConnections();
	await new Promise((resolve) => agent.close(resolve));
	await testDb.close();
	await mock.close();
});

test.skipIf(skip)(
	"a usage reply that breaks mid-body answers 503, not 500",
	async () => {
		const alice = new CookieJar();
		await loginAs(app, "alice", alice);
		const id = (
			await app.inject({
				method: "POST",
				url: "/workspaces",
				headers: csrfHeaders(alice, PUBLIC_URL),
			})
		).json().id;
		await testDb.db
			.updateTable("workspaces")
			.set({
				state: "running",
				agent_address: "127.0.0.1",
				agent_token: AGENT_TOKEN,
				updated_at: new Date().toISOString(),
			})
			.where("id", "=", id)
			.execute();

		const response = await app.inject({
			method: "GET",
			url: `/workspaces/${id}/usage`,
			headers: { cookie: alice.cookieHeader() },
		});
		expect(response.statusCode).toBe(503);
		expect(response.json()).toEqual({
			code: "AGENT_UNAVAILABLE",
			message: "The workspace agent sent an answer we could not read.",
		});
	},
);

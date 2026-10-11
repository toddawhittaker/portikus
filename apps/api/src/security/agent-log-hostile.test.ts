import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { AGENT_LOG_MAX_REPLY_BYTES } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

/**
 * The admin agent-log route against a hostile workspace agent. The agent runs
 * as the student, so its log reply is untrusted (SPEC.md 24.1, ADR 0060): the
 * API must refuse an oversize or off-schema reply with a clear error, strip
 * control characters, and never crash.
 */

const skip = !hasTestDb();
const TOKEN = "hostile-log-token";

let testDb: TestDb;
let mock: MockOidcProvider;
let hostile: FastifyInstance;
let hostilePort: number;
/** The raw body the hostile agent answers `GET /log` with. */
let reply: string;
let app: FastifyInstance;
let carol: CookieJar;
let workspaceId: string;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
	hostile = Fastify();
	hostile.get("/log", async (_request, response) =>
		response.header("content-type", "application/json").send(reply),
	);
	await hostile.listen({ port: 0, host: "127.0.0.1" });
	const address = hostile.server.address();
	hostilePort = typeof address === "object" && address ? address.port : 0;
});

afterAll(async () => {
	if (skip) return;
	await hostile.close();
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: hostilePort });
	const alice = new CookieJar();
	await loginAs(app, "alice", alice);
	carol = new CookieJar();
	await loginAs(app, "carol", carol);
	workspaceId = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(alice, PUBLIC_URL),
		})
	).json().id;
	await testDb.db
		.updateTable("workspaces")
		.set({ state: "running", agent_address: "127.0.0.1", agent_token: TOKEN })
		.where("id", "=", workspaceId)
		.execute();
	return async () => {
		await app.close();
	};
});

function readLog() {
	return app.inject({
		method: "GET",
		url: `/admin/workspaces/${workspaceId}/agent-log`,
		headers: { cookie: carol.cookieHeader() },
	});
}

const line = (msg: string) => ({
	time: "2026-10-10T00:00:00.000Z",
	level: "warn",
	msg,
});

test.skipIf(skip)("an oversize reply is refused, not buffered", async () => {
	reply = JSON.stringify({
		lines: [line("x".repeat(AGENT_LOG_MAX_REPLY_BYTES + 10))],
	});
	const res = await readLog();
	expect(res.statusCode).toBe(503);
	expect(res.json().code).toBe("AGENT_UNAVAILABLE");
	expect(res.json().message).toMatch(/too large/);
});

test.skipIf(skip)("a reply off the schema is refused with a clear error", async () => {
	for (const body of [
		"not json",
		"[]",
		JSON.stringify({ lines: [{ ...line("m"), path: "/home/student/secret" }] }),
		JSON.stringify({ lines: [{ ...line("m"), level: "info" }] }),
		JSON.stringify({ lines: Array.from({ length: 201 }, () => line("m")) }),
	]) {
		reply = body;
		const res = await readLog();
		expect(res.statusCode).toBe(503);
		expect(res.json()).toEqual({
			code: "AGENT_UNAVAILABLE",
			message: "The workspace agent sent a log we could not read.",
		});
	}
});

test.skipIf(skip)("control characters are stripped from every string", async () => {
	reply = JSON.stringify({
		lines: [
			{
				...line("first\nforged line\u001b[31m red\u0007\u009b"),
				code: "E\r\nX",
			},
		],
	});
	const res = await readLog();
	expect(res.statusCode).toBe(200);
	expect(res.json()).toEqual({
		lines: [
			{
				time: "2026-10-10T00:00:00.000Z",
				level: "warn",
				msg: "firstforged line[31m red",
				code: "EX",
			},
		],
	});
});

test.skipIf(skip)("the API still answers after a hostile reply", async () => {
	reply = "{".repeat(1000);
	expect((await readLog()).statusCode).toBe(503);
	reply = JSON.stringify({ lines: [line("ok")] });
	const res = await readLog();
	expect(res.statusCode).toBe(200);
	expect(res.json().lines).toHaveLength(1);
});

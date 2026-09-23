import { Writable } from "node:stream";
import {
	MOCK_USERS,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { createLogger } from "@portikus/observability";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import {
	buildMatrixWorld,
	buildTestServer,
	DISABLED_MOCK_USER,
} from "../test-support.js";

/** HEAD on a browser socket route is a clean 4xx, never a 500 (issue #402). */

const skip = !hasTestDb();
const AGENT_TOKEN = "socket-head-agent-token";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		users: { ...MOCK_USERS, [DISABLED_MOCK_USER.sub]: DISABLED_MOCK_USER },
	});
	agent = await startFakeAgent(AGENT_TOKEN);
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
	await agent.close();
});

describe.skipIf(skip)("HEAD on a socket route", () => {
	test("answers a 4xx with the error shape and logs no error", async () => {
		const lines: string[] = [];
		const logger = createLogger({
			service: "api",
			level: "debug",
			destination: new Writable({
				write(chunk, _encoding, callback) {
					lines.push(String(chunk));
					callback();
				},
			}),
		});
		const app = buildTestServer(
			testDb.db,
			mock.issuer,
			{ AGENT_PORT: agent.port },
			logger,
		);
		await app.ready();
		try {
			const world = await buildMatrixWorld(app, testDb.db, AGENT_TOKEN);
			const { workspaceId: id, projectId: pid, terminalId: tid } = world.a;
			const urls = [
				`/workspaces/${id}/ws`,
				`/workspaces/${id}/terminals/${tid}/ws`,
				`/workspaces/${id}/projects/${pid}/events`,
				`/workspaces/${id}/projects/${pid}/checks/lint/runs/current`,
			];
			const callers = [
				{ name: "owner", headers: { cookie: world.a.jar.cookieHeader() }, status: 404 },
				{ name: "signed out", headers: {}, status: 401 },
			];
			for (const url of urls) {
				for (const caller of callers) {
					const why = `HEAD ${url} for ${caller.name}`;
					const head = await app.inject({
						method: "HEAD",
						url,
						headers: caller.headers,
					});
					expect(head.statusCode, why).toBe(caller.status);
					// A real HEAD answer drops the body on the wire; inject keeps it.
					const body = head.json() as { code?: unknown; message?: unknown };
					expect(typeof body.code, why).toBe("string");
					expect(typeof body.message, why).toBe("string");
				}
			}
			const errors = lines
				.map((line) => JSON.parse(line))
				.filter((l) => l.level === "error");
			expect(errors).toEqual([]);
		} finally {
			await app.close();
		}
	});
});

import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/**
 * Terminal metadata routes (SPEC.md §9.3, §9.6, §9.7). The API owns the
 * durable row; the agent owns the tmux session.
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "fake-agent-token";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let workspaceId: string;

async function makeRunningWorkspace(jar: CookieJar): Promise<string> {
	const id = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(jar, PUBLIC_URL),
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
	return id;
}

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
	agent = await startFakeAgent(AGENT_TOKEN);
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
	await agent.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	agent.terminals.clear();
	agent.received.length = 0;
	agent.failCreateWith = null;
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
	workspaceId = await makeRunningWorkspace(alice);
	return async () => {
		await app.close();
	};
});

async function create(
	jar: CookieJar,
	id: string,
	payload: Record<string, unknown> = {},
) {
	return await app.inject({
		method: "POST",
		url: `/workspaces/${id}/terminals`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload,
	});
}

test.skipIf(skip)("create, list, rename, and delete a terminal", async () => {
	const created = await create(alice, workspaceId);
	expect(created.statusCode).toBe(201);
	const terminal = created.json();
	expect(terminal.name).toBe("Terminal 1");
	expect(terminal.cwd).toBe("/home/student/projects");
	expect(terminal.endedAt).toBeNull();
	expect(agent.terminals.has(terminal.id)).toBe(true);

	const listed = await app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/terminals`,
		headers: { cookie: alice.cookieHeader() },
	});
	expect(listed.statusCode).toBe(200);
	expect(listed.json().terminals).toHaveLength(1);

	const renamed = await app.inject({
		method: "PATCH",
		url: `/workspaces/${workspaceId}/terminals/${terminal.id}`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: { name: "build" },
	});
	expect(renamed.statusCode).toBe(200);
	expect(renamed.json().name).toBe("build");

	const deleted = await app.inject({
		method: "DELETE",
		url: `/workspaces/${workspaceId}/terminals/${terminal.id}`,
		headers: csrfHeaders(alice, PUBLIC_URL),
	});
	expect(deleted.statusCode).toBe(204);
	expect(agent.terminals.has(terminal.id)).toBe(false);

	// Closing is a user action, so the terminal goes away (SPEC.md section 9.3).
	const after = await app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/terminals`,
		headers: { cookie: alice.cookieHeader() },
	});
	expect(after.json().terminals).toHaveLength(0);
	const rows = await testDb.db.selectFrom("terminals").selectAll().execute();
	expect(rows).toHaveLength(0);
});

test.skipIf(skip)("an administrator is refused on every terminal route", async () => {
	const created = await create(alice, workspaceId);
	const terminalId = created.json().id;

	// Administrators may list workspaces but must not read or drive a
	// student's terminal (SPEC.md section 20.2).
	const carol = new CookieJar();
	await loginAs(app, "carol", carol);

	const listed = await app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/terminals`,
		headers: { cookie: carol.cookieHeader() },
	});
	expect(listed.statusCode).toBe(404);

	expect((await create(carol, workspaceId)).statusCode).toBe(404);

	const renamed = await app.inject({
		method: "PATCH",
		url: `/workspaces/${workspaceId}/terminals/${terminalId}`,
		headers: csrfHeaders(carol, PUBLIC_URL),
		payload: { name: "watched" },
	});
	expect(renamed.statusCode).toBe(404);

	const deleted = await app.inject({
		method: "DELETE",
		url: `/workspaces/${workspaceId}/terminals/${terminalId}`,
		headers: csrfHeaders(carol, PUBLIC_URL),
	});
	expect(deleted.statusCode).toBe(404);
	expect(agent.terminals.has(terminalId)).toBe(true);
});

test.skipIf(skip)(
	"the listing keeps every open terminal and 20 ended ones",
	async () => {
		const open = (await create(alice, workspaceId)).json().id;

		// Terminals the platform ended, the way a workspace stop leaves them.
		for (let i = 0; i < 25; i += 1) {
			await testDb.db
				.insertInto("terminals")
				.values({
					id: crypto.randomUUID(),
					workspace_id: workspaceId,
					name: `old ${i}`,
					cwd: "/home/student/projects",
					position: i + 1,
					ended_at: new Date(Date.now() - (25 - i) * 60_000).toISOString(),
				})
				.execute();
		}

		const listed = await app.inject({
			method: "GET",
			url: `/workspaces/${workspaceId}/terminals`,
			headers: { cookie: alice.cookieHeader() },
		});
		const terminals = listed.json().terminals as Array<{
			id: string;
			name: string;
			endedAt: string | null;
		}>;
		expect(terminals).toHaveLength(21);
		expect(terminals.filter((t) => t.endedAt === null).map((t) => t.id)).toEqual([
			open,
		]);
		// The five oldest ended terminals are dropped, the newest kept.
		const names = terminals.map((t) => t.name);
		expect(names).not.toContain("old 0");
		expect(names).toContain("old 24");
	},
);

test.skipIf(skip)("a chosen name and working directory are kept", async () => {
	const created = await create(alice, workspaceId, {
		name: "tests",
		cwd: "/home/student/projects/demo",
	});
	expect(created.statusCode).toBe(201);
	expect(created.json().name).toBe("tests");
	expect(agent.terminals.get(created.json().id)?.cwd).toBe(
		"/home/student/projects/demo",
	);
});

test.skipIf(skip)("another student sees 404 on every terminal route", async () => {
	const created = await create(alice, workspaceId);
	const terminalId = created.json().id;

	const bob = new CookieJar();
	await loginAs(app, "bob", bob);

	const listed = await app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/terminals`,
		headers: { cookie: bob.cookieHeader() },
	});
	expect(listed.statusCode).toBe(404);

	expect((await create(bob, workspaceId)).statusCode).toBe(404);

	const renamed = await app.inject({
		method: "PATCH",
		url: `/workspaces/${workspaceId}/terminals/${terminalId}`,
		headers: csrfHeaders(bob, PUBLIC_URL),
		payload: { name: "stolen" },
	});
	expect(renamed.statusCode).toBe(404);

	const deleted = await app.inject({
		method: "DELETE",
		url: `/workspaces/${workspaceId}/terminals/${terminalId}`,
		headers: csrfHeaders(bob, PUBLIC_URL),
	});
	expect(deleted.statusCode).toBe(404);
	expect(agent.terminals.has(terminalId)).toBe(true);
});

test.skipIf(skip)("the ninth terminal is refused", async () => {
	for (let i = 0; i < 8; i += 1) {
		expect((await create(alice, workspaceId)).statusCode).toBe(201);
	}
	const ninth = await create(alice, workspaceId);
	expect(ninth.statusCode).toBe(409);
	expect(ninth.json().code).toBe("TERMINAL_LIMIT");
});

test.skipIf(skip)("a closed terminal frees a slot", async () => {
	const ids: string[] = [];
	for (let i = 0; i < 8; i += 1) {
		ids.push((await create(alice, workspaceId)).json().id);
	}
	await app.inject({
		method: "DELETE",
		url: `/workspaces/${workspaceId}/terminals/${ids[0]}`,
		headers: csrfHeaders(alice, PUBLIC_URL),
	});
	expect((await create(alice, workspaceId)).statusCode).toBe(201);
});

test.skipIf(skip)(
	"a workspace that is not running cannot create a terminal",
	async () => {
		await testDb.db
			.updateTable("workspaces")
			.set({ state: "stopped", updated_at: new Date().toISOString() })
			.where("id", "=", workspaceId)
			.execute();

		const refused = await create(alice, workspaceId);
		expect(refused.statusCode).toBe(409);
		expect(refused.json().code).toBe("AGENT_UNAVAILABLE");
	},
);

test.skipIf(skip)("an unreachable agent gives 503 and leaves no row", async () => {
	// Point the workspace at an address nothing is listening on.
	await testDb.db
		.updateTable("workspaces")
		.set({ agent_address: "127.0.0.127", updated_at: new Date().toISOString() })
		.where("id", "=", workspaceId)
		.execute();

	const refused = await create(alice, workspaceId);
	expect(refused.statusCode).toBe(503);
	expect(refused.json().code).toBe("AGENT_UNAVAILABLE");

	const rows = await testDb.db.selectFrom("terminals").selectAll().execute();
	expect(rows).toHaveLength(0);
});

test.skipIf(skip)("a bad working directory is a 400 and leaves no row", async () => {
	agent.failCreateWith = "INVALID_CWD";
	const refused = await create(alice, workspaceId, { cwd: "/etc" });
	expect(refused.statusCode).toBe(400);
	expect(refused.json().code).toBe("VALIDATION_FAILED");

	const rows = await testDb.db.selectFrom("terminals").selectAll().execute();
	expect(rows).toHaveLength(0);
});

test.skipIf(skip)("renaming a terminal that does not exist is 404", async () => {
	const renamed = await app.inject({
		method: "PATCH",
		url: `/workspaces/${workspaceId}/terminals/${crypto.randomUUID()}`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: { name: "ghost" },
	});
	expect(renamed.statusCode).toBe(404);
	expect(renamed.json().code).toBe("TERMINAL_NOT_FOUND");
});

test.skipIf(skip)("the preview route answers 501 for now", async () => {
	const preview = await app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/preview/3000/`,
		headers: { cookie: alice.cookieHeader() },
	});
	expect(preview.statusCode).toBe(501);
});

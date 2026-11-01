import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	openWorkspaceSocket,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

/**
 * Agent states reach the workspace owner's sockets only (SPEC.md §24, same
 * rule as the layout message).
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "ws-coding-agents-token";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let carol: CookieJar;
let workspaceId: string;
let projectId: string;
let terminalId: string;

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
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
	// Carol is an administrator, as in the other admin socket tests.
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
		.set({
			state: "running",
			agent_address: "127.0.0.1",
			agent_token: `${AGENT_TOKEN}:${workspaceId}`,
		})
		.where("id", "=", workspaceId)
		.execute();
	projectId = (
		await testDb.db
			.insertInto("projects")
			.values({
				workspace_id: workspaceId,
				slug: "alpha",
				name: "alpha",
				path: "/home/student/projects/alpha",
				source: "new",
			})
			.returning("id")
			.executeTakeFirstOrThrow()
	).id;
	terminalId = (
		await testDb.db
			.insertInto("terminals")
			.values({
				workspace_id: workspaceId,
				name: "Terminal",
				cwd: "/home/student/projects/alpha",
				project_id: projectId,
			})
			.returning("id")
			.executeTakeFirstOrThrow()
	).id;
	return async () => {
		await app.close();
	};
});

async function setAgents(terminals: unknown[]): Promise<void> {
	const response = await fetch(`http://127.0.0.1:${agent.port}/__test/coding-agents`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, terminals }),
	});
	expect(response.status).toBe(204);
}

async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !check(); i++) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

test.skipIf(skip)(
	"the owner is sent the list with project ids, an administrator never is",
	async () => {
		const admin = await openWorkspaceSocket(app, workspaceId, carol, PUBLIC_URL);
		const owner = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
		const isAgents = (m: { type: string }) => m.type === "coding-agents";

		// A new owner socket hears the current (empty) list at once.
		await until(() => owner.messages.some(isAgents));
		expect(owner.messages.filter(isAgents)).toEqual([
			{ type: "coding-agents", terminals: [] },
		]);

		const foreign = crypto.randomUUID();
		await setAgents([
			{ terminalId, agent: "codex", state: "needs-input" },
			{ terminalId: foreign, agent: "claude", state: "working" },
		]);
		await until(() => owner.messages.filter(isAgents).length >= 2);
		const last = owner.messages.filter(isAgents).at(-1) as {
			terminals: Array<Record<string, unknown>>;
		};
		// The terminal id the database does not hold is dropped.
		expect(last.terminals).toHaveLength(1);
		expect(last.terminals[0]).toMatchObject({
			terminalId,
			projectId,
			agent: "codex",
			state: "needs-input",
		});

		await setAgents([]);
		await until(() => owner.messages.filter(isAgents).length >= 3);
		expect(owner.messages.filter(isAgents).at(-1)).toEqual({
			type: "coding-agents",
			terminals: [],
		});

		expect(admin.messages.some(isAgents)).toBe(false);
		await admin.close();
		await owner.close();
	},
);

test.skipIf(skip)("a new owner socket is sent the list already held", async () => {
	await setAgents([{ terminalId, agent: "claude", state: "finished" }]);
	// Wait until the registry has it: a first owner socket sees it.
	const first = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
	await until(() =>
		first.messages.some((m) => m.type === "coding-agents" && m.terminals.length === 1),
	);
	const second = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
	await until(() => second.messages.some((m) => m.type === "coding-agents"));
	expect(second.messages.find((m) => m.type === "coding-agents")).toMatchObject({
		terminals: [{ terminalId, projectId, state: "finished" }],
	});
	await first.close();
	await second.close();
});

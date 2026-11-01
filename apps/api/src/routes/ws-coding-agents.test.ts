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
import type { KyselyPlugin } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

/**
 * Agent states reach the workspace owner's sockets only (SPEC.md §24, same
 * rule as the layout message).
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "ws-coding-agents-token";

/**
 * Counts the reads of the terminals table that attach projects to an agent
 * list, how many run at once, and can make each one slow.
 */
const probe = { delayMs: 0, queries: 0, active: 0, maxActive: 0 };
const probed = new Set<string>();
const terminalsProbe: KyselyPlugin = {
	transformQuery({ node, queryId }) {
		if (
			node.kind === "SelectQueryNode" &&
			JSON.stringify(node).includes('"terminals"')
		) {
			probed.add(queryId.queryId);
			probe.queries += 1;
			probe.active += 1;
			probe.maxActive = Math.max(probe.maxActive, probe.active);
		}
		return node;
	},
	async transformResult({ result, queryId }) {
		if (probed.delete(queryId.queryId)) {
			if (probe.delayMs > 0) await sleep(probe.delayMs);
			probe.active -= 1;
		}
		return result;
	},
};

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

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
	probe.delayMs = 0;
	probe.queries = 0;
	probe.active = 0;
	probe.maxActive = 0;
	app = buildTestServer(testDb.db.withPlugin(terminalsProbe), mock.issuer, {
		AGENT_PORT: agent.port,
	});
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

async function until(check: () => boolean, attempts = 200): Promise<void> {
	for (let i = 0; i < attempts && !check(); i++) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

test.skipIf(skip)(
	"the owner is sent the list with project ids, an administrator never is",
	async () => {
		const admin = await openWorkspaceSocket(app, workspaceId, carol, PUBLIC_URL);
		const owner = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
		const isAgents = (m: { type: string }) => m.type === "coding-agents";

		// The agent's first frame (an empty list) reaches the socket through the
		// subscription.
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

type AgentsMessage = { type: "coding-agents"; terminals: Array<{ since: string }> };

function agentsMessages(socket: {
	messages: Array<{ type: string }>;
}): AgentsMessage[] {
	return socket.messages.filter((m) => m.type === "coding-agents") as AgentsMessage[];
}

function stateAt(i: number): unknown {
	return {
		terminalId,
		agent: "claude",
		state: "working",
		since: new Date(1_000_000 + i).toISOString(),
	};
}

test.skipIf(skip)(
	"a socket opened before the agent's first frame is never sent an empty baseline",
	async () => {
		await setAgents([stateAt(0)]);
		const owner = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
		await until(() => agentsMessages(owner).length > 0);
		// Whichever of the connect and the first frame came first, the browser's
		// first list is the agent's real one.
		expect(agentsMessages(owner)[0]?.terminals).toHaveLength(1);
		await owner.close();
	},
);

test.skipIf(skip)(
	"a flood of differing frames costs a handful of reads and ends on the newest list",
	async () => {
		const owner = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
		await until(() => agentsMessages(owner).length > 0);
		probe.queries = 0;

		const started = Date.now();
		for (let i = 1; i <= 1000; i++) await setAgents([stateAt(i)]);
		const elapsed = Date.now() - started;
		const newest = new Date(1_000_000 + 1000).toISOString();
		await until(() => agentsMessages(owner).at(-1)?.terminals[0]?.since === newest);

		expect(agentsMessages(owner).at(-1)?.terminals[0]?.since).toBe(newest);
		// Four a second at most, plus the one that ends the burst.
		expect(probe.queries).toBeLessThanOrEqual(Math.ceil(elapsed / 250) + 2);
		expect(probe.maxActive).toBe(1);
		await owner.close();
	},
);

test.skipIf(skip)(
	"a slow database leaves at most one read running and one waiting",
	async () => {
		const owner = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
		await until(() => agentsMessages(owner).length > 0);
		probe.queries = 0;
		probe.delayMs = 800;

		// About 2.4 s of changes, so the registry announces nine or ten of them
		// while the first read is still running.
		const started = Date.now();
		for (let i = 1; i <= 20; i++) {
			await setAgents([stateAt(i)]);
			await sleep(120);
		}
		const elapsed = Date.now() - started;
		const newest = new Date(1_000_000 + 20).toISOString();
		await until(
			() => agentsMessages(owner).at(-1)?.terminals[0]?.since === newest,
			400,
		);

		expect(agentsMessages(owner).at(-1)?.terminals[0]?.since).toBe(newest);
		expect(probe.maxActive).toBe(1);
		// A chain of sends would have run one read per announcement.
		expect(probe.queries).toBeLessThanOrEqual(Math.ceil(elapsed / 800) + 2);
		await owner.close();
	},
);

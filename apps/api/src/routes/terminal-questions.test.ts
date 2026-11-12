import {
	csrfHeaders,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import type { AgentCodingAgentStatus } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import {
	buildMatrixWorld,
	buildTestServer,
	MATRIX_MOCK_USERS,
	type MatrixWorld,
	PUBLIC_URL,
} from "../testing/test-support.js";

/**
 * The browser's answer to a terminal's Claude Code question (SPEC.md 10.8,
 * 24.1): the owner alone may send it, to an open terminal tab, and nothing in
 * it is logged.
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "terminal-question-token";
/** Student A's workspace key in the fake agent: the suffix of the matrix world's token. */
const fakeKey = (): string => world.a.agentToken.slice(AGENT_TOKEN.length + 1);
const QUESTION_ID = "toolu_01Q";
const QUESTION_TEXT = "Which secret database?";
const ANSWER_TEXT = "Postgres-under-the-floorboards";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let world: MatrixWorld;
const logs = collectingLogger("debug");

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ users: MATRIX_MOCK_USERS });
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
	logs.lines.length = 0;
	app = buildTestServer(
		testDb.db,
		mock.issuer,
		{ AGENT_PORT: agent.port },
		logs.logger,
	);
	await app.listen({ port: 0, host: "127.0.0.1" });
	world = await buildMatrixWorld(app, testDb.db, AGENT_TOKEN);
	return async () => {
		await app.close();
	};
});

/** Put a question on the terminal's entry in the fake agent. */
async function ask(terminalId = world.a.terminalId, id = QUESTION_ID): Promise<void> {
	const terminal: Omit<AgentCodingAgentStatus, "since" | "subagents"> = {
		terminalId,
		agent: "claude",
		state: "needs-input",
		question: {
			id,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			questions: [
				{
					question: QUESTION_TEXT,
					header: "DB",
					options: [
						{ label: "Postgres", description: "The default" },
						{ label: "SQLite", description: "A file" },
					],
					multiSelect: false,
				},
			],
		},
	};
	const response = await fetch(`http://127.0.0.1:${agent.port}/__test/coding-agents`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: fakeKey(), terminals: [terminal] }),
	});
	expect(response.status).toBe(204);
}

async function forwarded(): Promise<unknown[]> {
	const response = await fetch(
		`http://127.0.0.1:${agent.port}/__test/terminal-questions?key=${fakeKey()}`,
	);
	return ((await response.json()) as { answers: unknown[] }).answers;
}

const ANSWER = { id: QUESTION_ID, answers: { [QUESTION_TEXT]: ANSWER_TEXT } };

function answer(
	jar: { cookieHeader(): string } & Parameters<typeof csrfHeaders>[0],
	payload: unknown = ANSWER,
	terminalId = world.a.terminalId,
	workspaceId = world.a.workspaceId,
) {
	return app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/terminals/${terminalId}/question`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: payload as object,
	});
}

test.skipIf(skip)(
	"the owner's answer reaches the agent and clears the question",
	async () => {
		await ask();
		const response = await answer(world.a.jar);
		expect(response.statusCode).toBe(204);
		expect(await forwarded()).toEqual([ANSWER]);
	},
);

test.skipIf(skip)('"answer in the terminal" is forwarded too', async () => {
	await ask();
	const response = await answer(world.a.jar, { id: QUESTION_ID, inTerminal: true });
	expect(response.statusCode).toBe(204);
	expect(await forwarded()).toEqual([{ id: QUESTION_ID, inTerminal: true }]);
});

test.skipIf(skip)("nobody but the owner may answer", async () => {
	await ask();
	await testDb.db
		.insertInto("project_shares")
		.values({
			project_id: world.a.projectId,
			ends_at: new Date(Date.now() + 3_600_000).toISOString(),
		})
		.execute();
	const helper = await testDb.db
		.selectFrom("users")
		.select("id")
		.where("oidc_subject", "=", "ivy")
		.executeTakeFirstOrThrow();
	await testDb.db
		.insertInto("live_help_sessions")
		.values({
			workspace_id: world.a.workspaceId,
			project_id: world.a.projectId,
			helper_user_id: helper.id,
			course_id: world.courseId,
			ends_at: new Date(Date.now() + 3_600_000).toISOString(),
		})
		.execute();

	const refusals: Array<[string, typeof world.admin]> = [
		["a share viewer", world.b.jar],
		["an instructor who is also the live-help helper", world.instructor],
		["an administrator", world.admin],
	];
	for (const [who, jar] of refusals) {
		expect((await answer(jar)).statusCode, who).toBe(404);
	}
	expect(await forwarded()).toEqual([]);
});

test.skipIf(skip)("an anonymous caller is refused", async () => {
	const response = await app.inject({
		method: "POST",
		url: `/workspaces/${world.a.workspaceId}/terminals/${world.a.terminalId}/question`,
		payload: ANSWER,
	});
	expect([401, 403]).toContain(response.statusCode);
	expect(await forwarded()).toEqual([]);
});

test.skipIf(skip)("a chat tab takes no terminal answer", async () => {
	const created = await app.inject({
		method: "POST",
		url: `/workspaces/${world.a.workspaceId}/terminals`,
		headers: csrfHeaders(world.a.jar, PUBLIC_URL),
		payload: { kind: "chat", agent: "claude", projectId: world.a.projectId },
	});
	expect(created.statusCode).toBe(201);
	const chatId = created.json().id as string;
	await ask(chatId);
	expect((await answer(world.a.jar, ANSWER, chatId)).statusCode).toBe(404);
	expect(await forwarded()).toEqual([]);
});

test.skipIf(skip)("an unknown, foreign or closed terminal is a 404", async () => {
	await ask();
	const unknown = "00000000-0000-4000-8000-000000000000";
	expect((await answer(world.a.jar, ANSWER, unknown)).statusCode).toBe(404);
	expect((await answer(world.a.jar, ANSWER, world.b.terminalId)).statusCode).toBe(404);

	await testDb.db
		.updateTable("terminals")
		.set({ ended_at: new Date().toISOString() })
		.where("id", "=", world.a.terminalId)
		.execute();
	expect((await answer(world.a.jar)).statusCode).toBe(404);
	expect(await forwarded()).toEqual([]);
});

test.skipIf(skip)("another student's workspace is a 404", async () => {
	await ask();
	const response = await answer(
		world.b.jar,
		ANSWER,
		world.a.terminalId,
		world.a.workspaceId,
	);
	expect(response.statusCode).toBe(404);
});

test.skipIf(skip)("a question that is gone answers 409", async () => {
	// Nothing waits.
	let response = await answer(world.a.jar);
	expect(response.statusCode).toBe(409);
	expect(response.json().message).toContain("answered in the terminal or timed out");

	// Another question waits, not the one the browser answered.
	await ask(world.a.terminalId, "toolu_other");
	response = await answer(world.a.jar);
	expect(response.statusCode).toBe(409);

	// The first answer wins; a second finds the question gone.
	await ask();
	expect((await answer(world.a.jar)).statusCode).toBe(204);
	expect((await answer(world.a.jar)).statusCode).toBe(409);
});

test.skipIf(skip)(
	"a body off the contract is a 400 and never reaches the agent",
	async () => {
		await ask();
		const bad: unknown[] = [
			{},
			{ id: QUESTION_ID },
			{ id: "not a tool id!", inTerminal: true },
			{ id: QUESTION_ID, inTerminal: false },
			{ id: QUESTION_ID, answers: {}, inTerminal: true },
			{ id: QUESTION_ID, answers: { q: 1 } },
			{ id: QUESTION_ID, answers: {}, extra: "x" },
		];
		for (const payload of bad) {
			expect(
				(await answer(world.a.jar, payload)).statusCode,
				JSON.stringify(payload),
			).toBe(400);
		}
		expect(await forwarded()).toEqual([]);
	},
);

test.skipIf(skip)("a bad answer's error quotes none of what was sent", async () => {
	const response = await answer(world.a.jar, {
		id: QUESTION_ID,
		answers: { [QUESTION_TEXT]: 42 },
		secret: ANSWER_TEXT,
	});
	expect(response.statusCode).toBe(400);
	expect(response.body).not.toContain(ANSWER_TEXT);
	expect(response.body).not.toContain(QUESTION_TEXT);
});

test.skipIf(skip)("a stopped workspace has no agent to answer to", async () => {
	await testDb.db
		.updateTable("workspaces")
		.set({ state: "stopped" })
		.where("id", "=", world.a.workspaceId)
		.execute();
	expect((await answer(world.a.jar)).statusCode).toBe(503);
});

test.skipIf(skip)(
	"the question, options and answer are never logged or stored",
	async () => {
		await ask();
		await answer(world.a.jar);
		await answer(world.a.jar, { id: QUESTION_ID, answers: { [QUESTION_TEXT]: 42 } });
		const logged = JSON.stringify(logs.lines);
		expect(logged).not.toContain(ANSWER_TEXT);
		expect(logged).not.toContain(QUESTION_TEXT);

		const audit = await testDb.db.selectFrom("audit_events").selectAll().execute();
		expect(JSON.stringify(audit)).not.toContain(ANSWER_TEXT);
		expect(audit.some((row) => String(row.action).includes("question"))).toBe(false);
	},
);

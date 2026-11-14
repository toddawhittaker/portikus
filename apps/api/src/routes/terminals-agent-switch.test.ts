import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

/**
 * Swapping a chat tab's coding agent (SPEC.md §10.8): the API asks the
 * workspace agent to replace the chat's host, forwarding only the new
 * agent's institutional key (§10.6), then records the tab's new agent.
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "fake-agent-token";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let workspaceId: string;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ redirectUris: [`${PUBLIC_URL}/auth/callback`] });
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
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
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
			agent_token: AGENT_TOKEN,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", workspaceId)
		.execute();
	return async () => {
		vi.unstubAllEnvs();
		await app.close();
	};
});

async function create(payload: Record<string, unknown>): Promise<string> {
	const created = await app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/terminals`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload,
	});
	expect(created.statusCode).toBe(201);
	return created.json().id;
}

function patch(terminalId: string, payload: Record<string, unknown>) {
	return app.inject({
		method: "PATCH",
		url: `/workspaces/${workspaceId}/terminals/${terminalId}`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload,
	});
}

test.skipIf(skip)(
	"a chat swaps to the other agent, which gets only its own key, and the row follows",
	async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "claude-key");
		vi.stubEnv("OPENAI_API_KEY", "codex-key");
		const id = await create({ kind: "chat", agent: "claude" });
		expect(agent.terminals.get(id)?.institutionalEnv).toEqual({
			ANTHROPIC_API_KEY: "claude-key",
		});
		const swapped = await patch(id, { agent: "codex" });
		expect(swapped.statusCode).toBe(200);
		expect(swapped.json().agent).toBe("codex");
		expect(agent.terminals.get(id)).toMatchObject({
			agent: "codex",
			institutionalEnv: { OPENAI_API_KEY: "codex-key" },
		});
		expect(agent.requests).toContainEqual({
			method: "POST",
			url: `/terminals/${id}/chat-agent`,
		});
		// Asking for the agent it already runs changes nothing on the agent.
		const calls = agent.requests.length;
		expect((await patch(id, { agent: "codex" })).statusCode).toBe(200);
		expect(agent.requests.length).toBe(calls);
	},
);

test.skipIf(skip)("a chat mid-reply refuses the swap and keeps its agent", async () => {
	const id = await create({ kind: "chat", agent: "claude" });
	await fetch(`http://127.0.0.1:${agent.port}/__test/chats/${id}/swap`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ refuse: true }),
	});
	const refused = await patch(id, { agent: "codex" });
	expect(refused.statusCode).toBe(409);
	expect(refused.json()).toMatchObject({
		code: "BUSY",
		message: "Wait for the reply to finish before switching agents.",
	});
	const row = await testDb.db
		.selectFrom("terminals")
		.select("agent")
		.where("id", "=", id)
		.executeTakeFirstOrThrow();
	expect(row.agent).toBe("claude");
});

test.skipIf(skip)("only an open chat tab can change agents", async () => {
	const shell = await create({});
	expect((await patch(shell, { agent: "codex" })).statusCode).toBe(404);
	const cli = await create({ agent: "claude" });
	expect((await patch(cli, { agent: "codex" })).statusCode).toBe(404);
	expect((await patch(crypto.randomUUID(), { agent: "codex" })).statusCode).toBe(404);
	expect((await patch(shell, { agent: "gemini" })).statusCode).toBe(400);
});

test.skipIf(skip)("a stopped workspace cannot swap a chat's agent", async () => {
	const id = await create({ kind: "chat", agent: "claude" });
	await testDb.db
		.updateTable("workspaces")
		.set({ state: "stopped" })
		.where("id", "=", workspaceId)
		.execute();
	const refused = await patch(id, { agent: "codex" });
	expect(refused.statusCode).toBe(409);
	expect(refused.json().code).toBe("AGENT_UNAVAILABLE");
});

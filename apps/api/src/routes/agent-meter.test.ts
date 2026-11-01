import { randomUUID } from "node:crypto";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { AgentMeter } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

/** The status bar's agent meter (SPEC.md §25.10). */

const skip = !hasTestDb();
const AGENT_TOKEN = "agent-meter-token";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let bob: CookieJar;
let carol: CookieJar;
let workspaceId: string;
let aliceId: string;

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

async function start(overrides: { AGENT_PORT?: number } = {}): Promise<void> {
	app = buildTestServer(testDb.db, mock.issuer, {
		AGENT_PORT: agent.port,
		...overrides,
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	bob = new CookieJar();
	carol = new CookieJar();
	await loginAs(app, "alice", alice);
	await loginAs(app, "bob", bob);
	await loginAs(app, "carol", carol);
	workspaceId = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(alice, PUBLIC_URL),
		})
	).json().id;
	const row = await testDb.db
		.updateTable("workspaces")
		.set({
			state: "running",
			agent_address: "127.0.0.1",
			agent_token: `${AGENT_TOKEN}:${workspaceId}`,
		})
		.where("id", "=", workspaceId)
		.returning("owner_user_id")
		.executeTakeFirstOrThrow();
	aliceId = row.owner_user_id;
}

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	return async () => {
		await app?.close();
	};
});

const inDays = (days: number): string =>
	new Date(Date.now() + days * 86_400_000).toISOString();

async function setLimits(body: Record<string, unknown>): Promise<void> {
	const response = await fetch(`http://127.0.0.1:${agent.port}/__test/agent-limits`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, ...body }),
	});
	expect(response.status).toBe(204);
}

function meter(jar: CookieJar) {
	return app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/agent-meter`,
		headers: { cookie: jar.cookieHeader() },
	});
}

async function addUsage(
	userId: string,
	daysAgo: number,
	values: {
		agent?: "claude" | "codex";
		model?: string;
		input?: number;
		cost?: number;
	} = {},
) {
	await testDb.db
		.insertInto("agent_usage_days")
		.values({
			user_id: userId,
			boot_id: randomUUID(),
			day: new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10),
			agent: values.agent ?? "claude",
			model: values.model ?? "opus",
			sessions: 1,
			input_tokens: values.input ?? 10,
			output_tokens: 5,
			cost_usd: values.cost ?? null,
			lines_added: 3,
			lines_removed: 1,
		})
		.execute();
}

test.skipIf(skip)(
	"the owner gets limits from the agent and today's counts",
	async () => {
		await start();
		await setLimits({
			claude: {
				windows: [{ name: "5h", usedPercent: 42, resetsAt: inDays(0.1) }],
			},
		});
		await addUsage(aliceId, 0, { input: 10, cost: 0.5 });
		await addUsage(aliceId, 0, { model: "sonnet", input: 20, cost: 0.25 });
		await addUsage(aliceId, 1, { input: 999 });

		const response = await meter(alice);
		expect(response.statusCode).toBe(200);
		const body = AgentMeter.parse(response.json());
		const claude = body.agents.find((one) => one.agent === "claude");
		const codex = body.agents.find((one) => one.agent === "codex");
		expect(claude?.limits?.windows[0]).toMatchObject({ name: "5h", usedPercent: 42 });
		expect(claude?.today).toMatchObject({
			sessions: 2,
			inputTokens: 30,
			outputTokens: 10,
			costUsd: 0.75,
			linesAdded: 6,
		});
		expect(codex).toEqual({ agent: "codex", limits: null, today: null });
	},
);

test.skipIf(skip)("an administrator and other students get 404", async () => {
	await start();
	expect((await meter(carol)).statusCode).toBe(404);
	expect((await meter(bob)).statusCode).toBe(404);
	expect(
		(await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/agent-meter` }))
			.statusCode,
	).toBe(401);
});

test.skipIf(skip)("another user's counts never appear", async () => {
	await start();
	const bobId = (
		await testDb.db
			.selectFrom("users")
			.select("id")
			.where("display_name", "like", "Bob%")
			.executeTakeFirstOrThrow()
	).id;
	await addUsage(bobId, 0, { input: 12345 });
	const body = AgentMeter.parse((await meter(alice)).json());
	expect(body.agents.every((one) => one.today === null)).toBe(true);
});

test.skipIf(skip)("an agent that cannot be reached leaves limits null", async () => {
	await start({ AGENT_PORT: 1 });
	await addUsage(aliceId, 0, { input: 7 });
	const response = await meter(alice);
	expect(response.statusCode).toBe(200);
	const body = AgentMeter.parse(response.json());
	expect(body.agents.every((one) => one.limits === null)).toBe(true);
	expect(body.agents.find((one) => one.agent === "claude")?.today?.inputTokens).toBe(7);
});

test.skipIf(skip)("limits the contract rejects are left out", async () => {
	await start();
	// 200% used and a reset far in the future are both out of range.
	await setLimits({
		claude: {
			windows: [{ name: "5h", usedPercent: 200, resetsAt: inDays(1) }],
		},
		codex: {
			windows: [{ name: "7d", usedPercent: 10, resetsAt: inDays(90) }],
		},
	});
	const response = await meter(alice);
	expect(response.statusCode).toBe(200);
	const body = AgentMeter.parse(response.json());
	expect(body.agents.every((one) => one.limits === null)).toBe(true);
});

test.skipIf(skip)("a stopped workspace still answers, with no limits", async () => {
	await start();
	await testDb.db
		.updateTable("workspaces")
		.set({ state: "stopped", agent_address: null, agent_token: null })
		.where("id", "=", workspaceId)
		.execute();
	const response = await meter(alice);
	expect(response.statusCode).toBe(200);
	expect(AgentMeter.parse(response.json()).agents.map((one) => one.limits)).toEqual([
		null,
		null,
	]);
});

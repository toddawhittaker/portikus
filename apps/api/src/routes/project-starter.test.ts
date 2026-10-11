import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { StarterProjectResponse } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";

/**
 * The starter route behind a Deep Linking link (ADR 0058, SPEC.md §7.2): it
 * creates the project once, opens it after that, and never overwrites.
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "fake-agent-token";
const TEMPLATE = { name: "Starter", url: "https://example.com/starter.git" };

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let aliceId: string;
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

async function userId(sub: string): Promise<string> {
	const row = await testDb.db
		.selectFrom("users")
		.select("id")
		.where("oidc_subject", "=", sub)
		.executeTakeFirstOrThrow();
	return row.id;
}

async function makeWorkspace(
	jar: CookieJar,
	state: "running" | "stopped",
): Promise<string> {
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
			state,
			agent_address: "127.0.0.1",
			agent_token: AGENT_TOKEN,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", id)
		.execute();
	return id;
}

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	agent.projects.clear();
	app = buildTestServer(testDb.db, mock.issuer, {
		AGENT_PORT: agent.port,
		PROJECT_TEMPLATES: `${TEMPLATE.name}=${TEMPLATE.url}`,
		projectTemplates: [TEMPLATE],
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
	aliceId = await userId("alice");
	workspaceId = await makeWorkspace(alice, "running");
	return async () => {
		await app.close();
	};
});

async function addStarter(
	owner: string,
	source: { template: string } | { repository_url: string },
	options: { name?: string; expiresInMs?: number } = {},
): Promise<string> {
	const row = await testDb.db
		.insertInto("lti_starter_launches")
		.values({
			user_id: owner,
			project_name: options.name ?? "Lab One",
			template: "template" in source ? source.template : null,
			repository_url: "repository_url" in source ? source.repository_url : null,
			expires_at: new Date(Date.now() + (options.expiresInMs ?? 60_000)).toISOString(),
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

function useStarter(starterId: unknown, jar = alice, id = workspaceId) {
	return app.inject({
		method: "POST",
		url: `/workspaces/${id}/projects/starter`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: { starterId },
	});
}

async function starterCount(): Promise<number> {
	return (await testDb.db.selectFrom("lti_starter_launches").selectAll().execute())
		.length;
}

describe.skipIf(skip)("POST /workspaces/:id/projects/starter", () => {
	test("creates the template project once, then the starter is used up", async () => {
		const id = await addStarter(aliceId, { template: "Starter" });
		const res = await useStarter(id);
		expect(res.statusCode).toBe(201);
		const body = StarterProjectResponse.parse(res.json());
		expect(body.created).toBe(true);
		expect(body.project).toMatchObject({
			slug: "lab-one",
			name: "Lab One",
			source: "template",
		});
		expect(agent.projects.has("lab-one")).toBe(true);
		expect(await starterCount()).toBe(0);
		expect((await useStarter(id)).statusCode).toBe(404);
	});

	test("a repository starter clones it", async () => {
		const id = await addStarter(aliceId, {
			repository_url: "https://github.com/owner/oracle.git",
		});
		const res = await useStarter(id);
		expect(res.statusCode).toBe(201);
		expect(res.json().project.source).toBe("clone");
	});

	test("an existing project of that slug is opened as it is, never overwritten", async () => {
		const made = await app.inject({
			method: "POST",
			url: `/workspaces/${workspaceId}/projects`,
			headers: csrfHeaders(alice, PUBLIC_URL),
			payload: { name: "Lab One", source: "new" },
		});
		expect(made.statusCode).toBe(201);
		const before = agent.projects.get("lab-one");

		const res = await useStarter(await addStarter(aliceId, { template: "Starter" }));
		expect(res.statusCode).toBe(200);
		const body = StarterProjectResponse.parse(res.json());
		expect(body).toMatchObject({
			created: false,
			project: { id: made.json().id, source: "new", state: "active" },
		});
		expect(agent.projects.get("lab-one")).toBe(before);
		expect(await starterCount()).toBe(0);
	});

	test("an archived project of that slug comes back archived, not recreated", async () => {
		const made = await app.inject({
			method: "POST",
			url: `/workspaces/${workspaceId}/projects`,
			headers: csrfHeaders(alice, PUBLIC_URL),
			payload: { name: "Lab One", source: "new" },
		});
		await testDb.db
			.updateTable("projects")
			.set({ state: "archived", archived_at: new Date().toISOString() })
			.where("id", "=", made.json().id)
			.execute();
		const res = await useStarter(await addStarter(aliceId, { template: "Starter" }));
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({
			created: false,
			project: { id: made.json().id, state: "archived" },
		});
	});

	test("a folder already on disk with no row is refused by the agent and the starter is kept", async () => {
		agent.projects.set("lab-one", { isGitRepo: false });
		const res = await useStarter(await addStarter(aliceId, { template: "Starter" }));
		expect(res.statusCode).toBe(409);
		expect(res.json().code).toBe("PROJECT_EXISTS");
		expect(agent.projects.get("lab-one")).toEqual({ isGitRepo: false });
		expect(await starterCount()).toBe(1);
	});

	test("another user's starter is 404 and stays theirs", async () => {
		const bob = new CookieJar();
		await loginAs(app, "bob", bob);
		const id = await addStarter(await userId("bob"), { template: "Starter" });
		const res = await useStarter(id);
		expect(res.statusCode).toBe(404);
		expect(await starterCount()).toBe(1);
		expect(agent.projects.size).toBe(0);
	});

	test("an expired starter is 404", async () => {
		const id = await addStarter(
			aliceId,
			{ template: "Starter" },
			{ expiresInMs: -1000 },
		);
		expect((await useStarter(id)).statusCode).toBe(404);
		expect(agent.projects.size).toBe(0);
	});

	test("an unknown id is 404 and a malformed one 400", async () => {
		expect((await useStarter("00000000-0000-4000-8000-000000000000")).statusCode).toBe(
			404,
		);
		expect((await useStarter("not-a-uuid")).statusCode).toBe(400);
	});

	test("another student's workspace is 404", async () => {
		const bob = new CookieJar();
		await loginAs(app, "bob", bob);
		const bobWorkspace = await makeWorkspace(bob, "running");
		const id = await addStarter(aliceId, { template: "Starter" });
		expect((await useStarter(id, alice, bobWorkspace)).statusCode).toBe(404);
		expect(await starterCount()).toBe(1);
	});

	test("a stopped workspace is 409 and keeps the starter for later", async () => {
		await testDb.db
			.updateTable("workspaces")
			.set({ state: "stopped" })
			.where("id", "=", workspaceId)
			.execute();
		const res = await useStarter(await addStarter(aliceId, { template: "Starter" }));
		expect(res.statusCode).toBe(409);
		expect(await starterCount()).toBe(1);
	});
});

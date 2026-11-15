/**
 * Check history (SPEC.md §25 "Check result metadata", §18.1): finished runs
 * the workspace agent holds are kept under the caller's own project, the
 * newest 20 per check, and only the owner can read them (SPEC.md §24.1, §24.6).
 */
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { CHECK_HISTORY_PER_CHECK, CHECKS_FILE_PATH } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";
import { pruneCheckRuns } from "./check-history.js";

const skip = !hasTestDb();
const AGENT_TOKEN = "fake-agent-token";
const CHECKS = {
	checks: [
		{ id: "tests", name: "Tests", command: "npm test" },
		{ id: "lint", name: "Lint", command: "npm run lint false" },
	],
};

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let bob: CookieJar;

async function workspaceOf(jar: CookieJar, running = true): Promise<string> {
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
			state: running ? "running" : "stopped",
			agent_address: "127.0.0.1",
			agent_token: AGENT_TOKEN,
		})
		.where("id", "=", id)
		.execute();
	return id;
}

async function projectIn(workspaceId: string): Promise<string> {
	const row = await testDb.db
		.insertInto("projects")
		.values({
			workspace_id: workspaceId,
			slug,
			name: slug,
			path: `/home/student/projects/${slug}`,
			source: "new",
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

function base(ws: string, pid: string) {
	return `/workspaces/${ws}/projects/${pid}/checks`;
}

function history(jar: CookieJar, ws: string, pid: string, checkId = "tests") {
	return app.inject({
		method: "GET",
		url: `${base(ws, pid)}/${checkId}/history`,
		headers: { cookie: jar.cookieHeader() },
	});
}

function run(jar: CookieJar, ws: string, pid: string, checkId = "tests") {
	return app.inject({
		method: "POST",
		url: `${base(ws, pid)}/${checkId}/runs`,
		headers: csrfHeaders(jar, PUBLIC_URL),
	});
}

async function storedFor(pid: string) {
	return testDb.db
		.selectFrom("check_runs")
		.selectAll()
		.where("project_id", "=", pid)
		.execute();
}

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

// The fake agent outlives each test, so every test gets a project of its own.
let slug = "";
let slugCounter = 0;
let aliceWs: string;
let aliceProject: string;

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	agent.projects.clear();
	agent.files.clear();
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	bob = new CookieJar();
	await loginAs(app, "alice", alice);
	await loginAs(app, "bob", bob);
	slugCounter += 1;
	slug = `essay${slugCounter}`;
	aliceWs = await workspaceOf(alice);
	aliceProject = await projectIn(aliceWs);
	agent.projects.set(slug, { isGitRepo: false });
	agent.files.set(`${slug}/${CHECKS_FILE_PATH}`, {
		type: "file",
		content: Buffer.from(JSON.stringify(CHECKS), "utf8"),
	});
	return async () => {
		await app.close();
	};
});

test.skipIf(skip)(
	"each finished run is kept with its result, timing and output",
	async () => {
		await run(alice, aliceWs, aliceProject);
		await run(alice, aliceWs, aliceProject);
		await run(alice, aliceWs, aliceProject, "lint");

		const response = await history(alice, aliceWs, aliceProject);
		expect(response.statusCode).toBe(200);
		const runs = response.json().runs;
		expect(runs).toHaveLength(2);
		expect(runs[0]).toMatchObject({ checkId: "tests", state: "passed", exitCode: 0 });
		expect(runs[0].durationMs).toBeGreaterThanOrEqual(0);
		// Newest first.
		expect(Date.parse(runs[0].startedAt)).toBeGreaterThanOrEqual(
			Date.parse(runs[1].startedAt),
		);

		const lint = (await history(alice, aliceWs, aliceProject, "lint")).json().runs;
		expect(lint).toMatchObject([{ state: "failed", exitCode: 1 }]);

		const output = await app.inject({
			method: "GET",
			url: `${base(aliceWs, aliceProject)}/lint/history/${lint[0].id}/output`,
			headers: { cookie: alice.cookieHeader() },
		});
		expect(output.statusCode).toBe(200);
		expect(Buffer.from(output.json().output, "base64").toString()).toContain(
			"1 test failed",
		);
	},
);

test.skipIf(skip)("reading twice stores each run once", async () => {
	await run(alice, aliceWs, aliceProject);
	await history(alice, aliceWs, aliceProject);
	await history(alice, aliceWs, aliceProject);
	expect(await storedFor(aliceProject)).toHaveLength(1);
});

test.skipIf(skip)("history survives a stopped workspace", async () => {
	await run(alice, aliceWs, aliceProject);
	await history(alice, aliceWs, aliceProject);
	await testDb.db.updateTable("workspaces").set({ state: "stopped" }).execute();
	const response = await history(alice, aliceWs, aliceProject);
	expect(response.statusCode).toBe(200);
	expect(response.json().runs).toHaveLength(1);
});

test.skipIf(skip)(
	"a workspace's runs are kept only under its own project, never another's",
	async () => {
		const bobWs = await workspaceOf(bob);
		const bobProject = await projectIn(bobWs);
		// Bob's agent reports runs (this fake shares one agent between both).
		await run(bob, bobWs, bobProject);
		await history(bob, bobWs, bobProject);
		expect(await storedFor(bobProject)).toHaveLength(1);
		expect(await storedFor(aliceProject)).toHaveLength(0);

		// Bob cannot read, or write through, Alice's project.
		expect((await history(bob, aliceWs, aliceProject)).statusCode).toBe(404);
		expect((await history(bob, bobWs, aliceProject)).statusCode).toBe(404);
		expect(await storedFor(aliceProject)).toHaveLength(0);
		const stored = (await storedFor(bobProject))[0];
		const output = await app.inject({
			method: "GET",
			url: `${base(aliceWs, aliceProject)}/tests/history/${stored?.id}/output`,
			headers: { cookie: bob.cookieHeader() },
		});
		expect(output.statusCode).toBe(404);
		// Nor can Alice read Bob's run through her own project.
		const crossed = await app.inject({
			method: "GET",
			url: `${base(aliceWs, aliceProject)}/tests/history/${stored?.id}/output`,
			headers: { cookie: alice.cookieHeader() },
		});
		expect(crossed.statusCode).toBe(404);
	},
);

test.skipIf(skip)(
	"a signed-out caller gets a 401 and a bad check id a 400",
	async () => {
		const out = await app.inject({
			method: "GET",
			url: `${base(aliceWs, aliceProject)}/tests/history`,
		});
		expect(out.statusCode).toBe(401);
		expect((await history(alice, aliceWs, aliceProject, "Not_An_Id")).statusCode).toBe(
			400,
		);
	},
);

test.skipIf(skip)("only the newest runs of each check are kept", async () => {
	const values = Array.from({ length: CHECK_HISTORY_PER_CHECK + 5 }, (_, i) => ({
		project_id: aliceProject,
		check_id: "tests",
		agent_run_id: `r${i}`,
		state: "passed" as const,
		started_at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
		ended_at: new Date(Date.UTC(2026, 10, 1, 0, i, 5)).toISOString(),
		exit_code: 0,
	}));
	await testDb.db.insertInto("check_runs").values(values).execute();
	await testDb.db
		.insertInto("check_runs")
		.values({ ...values[0], check_id: "lint" } as (typeof values)[number])
		.execute();
	await pruneCheckRuns(testDb.db, aliceProject, ["tests"]);
	const kept = await storedFor(aliceProject);
	const tests = kept
		.filter((row) => row.check_id === "tests")
		.map((row) => row.agent_run_id);
	expect(tests).toHaveLength(CHECK_HISTORY_PER_CHECK);
	expect(tests).not.toContain("r4");
	expect(tests).toContain("r5");
	// Another check's runs are untouched.
	expect(kept.filter((row) => row.check_id === "lint")).toHaveLength(1);

	// A read through the route prunes too.
	await run(alice, aliceWs, aliceProject);
	const runs = (await history(alice, aliceWs, aliceProject)).json().runs;
	expect(runs).toHaveLength(CHECK_HISTORY_PER_CHECK);
	expect(await storedFor(aliceProject)).toHaveLength(CHECK_HISTORY_PER_CHECK + 1);
});

test.skipIf(skip)(
	"an agent that cannot answer still leaves the stored runs readable",
	async () => {
		await run(alice, aliceWs, aliceProject);
		await history(alice, aliceWs, aliceProject);
		await testDb.db
			.updateTable("workspaces")
			.set({ agent_token: "wrong-token" })
			.where("id", "=", aliceWs)
			.execute();
		const response = await history(alice, aliceWs, aliceProject);
		expect(response.statusCode).toBe(200);
		expect(response.json().runs).toHaveLength(1);
	},
);

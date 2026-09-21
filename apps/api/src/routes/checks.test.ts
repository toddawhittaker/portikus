/**
 * The brokered check routes (SPEC.md §18.1). Only the owner of the workspace
 * gets through, a stopped workspace has no agent to reach, and the output
 * socket carries nothing from the browser to the workspace
 * (SPEC.md §5.2, §24.1, §24.6).
 */
import type { AddressInfo } from "node:net";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { CHECKS_FILE_PATH } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import WebSocketClient from "ws";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

const skip = !hasTestDb();
const AGENT_TOKEN = "fake-agent-token";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let bob: CookieJar;
let workspaceId: string;
let projectId: string;
let slug: string;

const CHECKS = {
	checks: [
		{ id: "tests", name: "Tests", command: "npm test" },
		{ id: "lint", name: "Lint", command: "npm run lint false" },
		{ id: "slow", name: "Slow", command: "sleep 30" },
	],
};

async function makeWorkspace(jar: CookieJar, running: boolean): Promise<string> {
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
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", id)
		.execute();
	return id;
}

async function makeProject(id: string, name: string): Promise<string> {
	const row = await testDb.db
		.insertInto("projects")
		.values({
			workspace_id: id,
			slug: name,
			name,
			path: `/home/student/projects/${name}`,
			source: "new",
		})
		.returningAll()
		.executeTakeFirstOrThrow();
	return row.id;
}

function url(id: string, pid: string, rest: string): string {
	return `/workspaces/${id}/projects/${pid}/checks${rest}`;
}

function get(jar: CookieJar, id: string, pid: string, rest = "") {
	return app.inject({
		method: "GET",
		url: url(id, pid, rest),
		headers: { cookie: jar.cookieHeader() },
	});
}

function post(jar: CookieJar, id: string, pid: string, rest: string) {
	return app.inject({
		method: "POST",
		url: url(id, pid, rest),
		headers: csrfHeaders(jar, PUBLIC_URL),
	});
}

function remove(jar: CookieJar, id: string, pid: string, rest: string) {
	return app.inject({
		method: "DELETE",
		url: url(id, pid, rest),
		headers: csrfHeaders(jar, PUBLIC_URL),
	});
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
	agent.projects.clear();
	agent.files.clear();
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	bob = new CookieJar();
	await loginAs(app, "alice", alice);
	await loginAs(app, "bob", bob);
	workspaceId = await makeWorkspace(alice, true);
	slug = "essay";
	projectId = await makeProject(workspaceId, slug);
	agent.projects.set(slug, { isGitRepo: false });
	agent.files.set(`${slug}/${CHECKS_FILE_PATH}`, {
		type: "file",
		content: Buffer.from(JSON.stringify(CHECKS), "utf8"),
	});
	return async () => {
		await app.close();
	};
});

test.skipIf(skip)("the owner sees the project's checks", async () => {
	const response = await get(alice, workspaceId, projectId);
	expect(response.statusCode).toBe(200);
	expect(response.json().checks).toEqual(CHECKS.checks);
	expect(response.json().error).toBeNull();
});

test.skipIf(skip)("a project with no checks file still answers", async () => {
	agent.files.clear();
	const response = await get(alice, workspaceId, projectId);
	expect(response.statusCode).toBe(200);
	expect(response.json()).toEqual({ checks: [], error: null, runs: [] });
});

test.skipIf(skip)("someone who is not the owner gets a 404", async () => {
	expect((await get(bob, workspaceId, projectId)).statusCode).toBe(404);
	expect((await post(bob, workspaceId, projectId, "/tests/runs")).statusCode).toBe(404);
	expect(
		(await remove(bob, workspaceId, projectId, "/tests/runs/current")).statusCode,
	).toBe(404);
});

test.skipIf(skip)("a signed-out caller gets a 401", async () => {
	const response = await app.inject({
		method: "GET",
		url: url(workspaceId, projectId, ""),
	});
	expect(response.statusCode).toBe(401);
});

test.skipIf(skip)("a stopped workspace has no agent to run a check on", async () => {
	const stopped = await makeWorkspace(alice, false);
	const stoppedProject = await makeProject(stopped, "other");
	const response = await post(alice, stopped, stoppedProject, "/tests/runs");
	expect(response.statusCode).toBe(409);
	expect(response.json().code).toBe("AGENT_UNAVAILABLE");
});

test.skipIf(skip)(
	"a passing and a failing check come back with their state",
	async () => {
		const passing = await post(alice, workspaceId, projectId, "/tests/runs");
		expect(passing.statusCode).toBe(201);
		expect(passing.json().checkId).toBe("tests");

		await post(alice, workspaceId, projectId, "/lint/runs");
		const runs = (await get(alice, workspaceId, projectId)).json().runs;
		const byId = new Map(runs.map((run: { checkId: string }) => [run.checkId, run]));
		expect(byId.get("tests")).toMatchObject({ state: "passed", exitCode: 0 });
		expect(byId.get("lint")).toMatchObject({ state: "failed", exitCode: 1 });
	},
);

test.skipIf(skip)("a check that is not configured is a 404", async () => {
	const response = await post(alice, workspaceId, projectId, "/nope/runs");
	expect(response.statusCode).toBe(404);
	expect(response.json().code).toBe("CHECK_NOT_FOUND");
});

test.skipIf(skip)("a check id the contract rejects is a 400", async () => {
	const response = await post(alice, workspaceId, projectId, "/NOT%20A%20SLUG/runs");
	expect(response.statusCode).toBe(400);
	expect(response.json().code).toBe("VALIDATION_FAILED");
});

test.skipIf(skip)(
	"a second run of a live check is a 409, and stopping it works",
	async () => {
		expect((await post(alice, workspaceId, projectId, "/slow/runs")).statusCode).toBe(
			201,
		);
		const second = await post(alice, workspaceId, projectId, "/slow/runs");
		expect(second.statusCode).toBe(409);
		expect(second.json().code).toBe("CHECK_RUNNING");

		expect(
			(await remove(alice, workspaceId, projectId, "/slow/runs/current")).statusCode,
		).toBe(204);
		const again = await remove(alice, workspaceId, projectId, "/slow/runs/current");
		expect(again.statusCode).toBe(404);
		expect(again.json().code).toBe("CHECK_NOT_RUNNING");
	},
);

test.skipIf(skip)(
	"the output socket carries the run's output to its owner",
	async () => {
		await post(alice, workspaceId, projectId, "/tests/runs");
		const port = (app.server.address() as AddressInfo).port;
		const socket = new WebSocketClient(
			`ws://127.0.0.1:${port}${url(workspaceId, projectId, "/tests/runs/current")}`,
			{
				headers: {
					origin: new URL(PUBLIC_URL).origin,
					cookie: alice.cookieHeader(),
				},
			},
		);
		const frames: Record<string, unknown>[] = [];
		socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
		await new Promise<void>((resolve) => socket.on("close", () => resolve()));

		const text = frames
			.filter((frame) => frame.type === "output")
			.map((frame) => Buffer.from(frame.data as string, "base64").toString("utf8"))
			.join("");
		expect(text).toContain("npm test");
		expect(frames.at(-1)).toEqual({ type: "exit", exitCode: 0 });
	},
);

test.skipIf(skip)(
	"the output socket is refused to someone who is not the owner",
	async () => {
		await post(alice, workspaceId, projectId, "/tests/runs");
		const port = (app.server.address() as AddressInfo).port;
		const socket = new WebSocketClient(
			`ws://127.0.0.1:${port}${url(workspaceId, projectId, "/tests/runs/current")}`,
			{
				headers: { origin: new URL(PUBLIC_URL).origin, cookie: bob.cookieHeader() },
			},
		);
		const failed = await new Promise<boolean>((resolve) => {
			socket.on("unexpected-response", () => resolve(true));
			socket.on("error", () => resolve(true));
			socket.on("open", () => resolve(false));
		});
		expect(failed).toBe(true);
		socket.close();
	},
);

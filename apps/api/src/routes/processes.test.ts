/**
 * The student's process stop route (SPEC.md §18.3, §24.11). Owner-only, one
 * stop at a time, rate limited, the
 * agent's refusals passed on, and an audit row with no name or command line.
 */
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";
import { PROCESS_STOPS_PER_MINUTE } from "../workspaces/process-stop.js";

const skip = !hasTestDb();
const AGENT_TOKEN = "fake-agent-token";
const SECRET_LINE = "node server.js --token=zzsecret";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let lines: Record<string, unknown>[];
let alice: CookieJar;
let bob: CookieJar;
let carol: CookieJar;
let workspaceId: string;

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

function stop(
	jar: CookieJar,
	pid: number | string,
	payload: unknown = { startTicks: 100 },
	id = workspaceId,
) {
	return app.inject({
		method: "POST",
		url: `/workspaces/${id}/processes/${pid}/stop`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: payload as Record<string, unknown>,
	});
}

async function audits() {
	return testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "workspace.process_stopped")
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

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	agent.processes.set("", [
		{
			pid: 1,
			command: "systemd",
			cpuPercent: 0,
			residentBytes: 1,
			startTicks: 1,
			stoppable: false,
			commandLine: null,
		},
		{
			pid: 7,
			command: "zzname",
			cpuPercent: 90,
			residentBytes: 1,
			startTicks: 100,
			stoppable: true,
			commandLine: SECRET_LINE,
		},
		{
			pid: 8,
			command: "stubborn",
			cpuPercent: 90,
			residentBytes: 1,
			startTicks: 200,
			stoppable: true,
			commandLine: SECRET_LINE,
			ignoresTerm: true,
		},
	]);
	const collected = collectingLogger("debug");
	lines = collected.lines;
	app = buildTestServer(
		testDb.db,
		mock.issuer,
		{ AGENT_PORT: agent.port },
		collected.logger,
	);
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	bob = new CookieJar();
	carol = new CookieJar();
	await loginAs(app, "alice", alice);
	await loginAs(app, "bob", bob);
	await loginAs(app, "carol", carol);
	workspaceId = await makeWorkspace(alice, true);
	return async () => {
		await app.close();
	};
});

test.skipIf(skip)(
	"the owner stops a process and one audit row records it",
	async () => {
		const response = await stop(alice, 7);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ pid: 7, exited: true });
		const rows = await audits();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.target).toBe(workspaceId);
		expect(rows[0]?.actor).toMatch(/^user:/);
		expect(rows[0]?.metadata).toEqual({ pid: 7, signal: "SIGTERM", exited: true });
		// Neither the audit row nor any log line names the process.
		const everything = JSON.stringify(rows) + JSON.stringify(lines);
		expect(everything).not.toContain("zzname");
		expect(everything).not.toContain("zzsecret");
	},
);

test.skipIf(skip)(
	"a process that outlives SIGTERM is reported, and force kills it",
	async () => {
		const soft = await stop(alice, 8, { startTicks: 200 });
		expect(soft.json()).toEqual({ pid: 8, exited: false });
		const hard = await stop(alice, 8, { startTicks: 200, force: true });
		expect(hard.json()).toEqual({ pid: 8, exited: true });
		expect((await audits()).map((row) => row.metadata)).toEqual(
			expect.arrayContaining([
				{ pid: 8, signal: "SIGTERM", exited: false },
				{ pid: 8, signal: "SIGKILL", exited: true },
			]),
		);
	},
);

test.skipIf(skip)("the agent's refusals pass through and are not audited", async () => {
	const gone = await stop(alice, 99);
	expect(gone.statusCode).toBe(404);
	expect(gone.json().code).toBe("PROCESS_NOT_FOUND");
	const changed = await stop(alice, 7, { startTicks: 101 });
	expect(changed.statusCode).toBe(409);
	expect(changed.json().code).toBe("PROCESS_CHANGED");
	const guarded = await stop(alice, 1, { startTicks: 1 });
	expect(guarded.statusCode).toBe(403);
	expect(guarded.json().code).toBe("PROCESS_PROTECTED");
	expect(await audits()).toEqual([]);
});

test.skipIf(skip)(
	"another student, an administrator, and a missing workspace get 404",
	async () => {
		expect((await stop(bob, 7)).statusCode).toBe(404);
		expect((await stop(carol, 7)).statusCode).toBe(404);
		expect(
			(
				await stop(
					alice,
					7,
					{ startTicks: 100 },
					"00000000-0000-4000-8000-000000000000",
				)
			).statusCode,
		).toBe(404);
		expect(await audits()).toEqual([]);
	},
);

test.skipIf(skip)("a stopped workspace answers 409", async () => {
	const stopped = await makeWorkspace(bob, false);
	const response = await stop(bob, 7, { startTicks: 100 }, stopped);
	expect(response.statusCode).toBe(409);
	expect(response.json().code).toBe("WORKSPACE_NOT_RUNNING");
});

test.skipIf(skip)("a bad pid or body is refused before the agent", async () => {
	for (const pid of ["0", "-1", "1.5", "abc", "99999999999"]) {
		expect((await stop(alice, pid)).statusCode, pid).toBe(400);
	}
	expect((await stop(alice, 7, {})).statusCode).toBe(400);
	expect((await stop(alice, 7, { startTicks: 100, extra: 1 })).statusCode).toBe(400);
});

test.skipIf(skip)("one stop at a time per workspace", async () => {
	const hold = agent.holdNextStop();
	const first = stop(alice, 7);
	await hold.reached;
	const second = await stop(alice, 8, { startTicks: 200 });
	expect(second.statusCode).toBe(409);
	expect(second.json().code).toBe("STOP_IN_PROGRESS");
	hold.release();
	expect((await first).statusCode).toBe(200);
});

test.skipIf(skip)("stops are rate limited per student", async () => {
	for (let i = 0; i < PROCESS_STOPS_PER_MINUTE; i++) {
		expect((await stop(alice, 99)).statusCode).toBe(404);
	}
	expect((await stop(alice, 99)).statusCode).toBe(429);
});

function treeAction(
	jar: CookieJar,
	action: "stop-tree" | "lower-priority",
	pid: number,
	payload: Record<string, unknown>,
	id = workspaceId,
) {
	return app.inject({
		method: "POST",
		url: `/workspaces/${id}/processes/${pid}/${action}`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload,
	});
}

/** zzname (7) runs a child (9), which runs the protected 10 and the stubborn 11. */
function seedTree() {
	const one = { cpuPercent: 1, residentBytes: 1, commandLine: SECRET_LINE };
	agent.processes.set("", [
		{ ...one, pid: 7, command: "zzname", startTicks: 100, stoppable: true },
		{ ...one, pid: 9, command: "child", startTicks: 300, stoppable: true, ppid: 7 },
		{ ...one, pid: 10, command: "guarded", startTicks: 310, stoppable: false, ppid: 9 },
		{
			...one,
			pid: 11,
			command: "stubborn",
			startTicks: 320,
			stoppable: true,
			ppid: 9,
			ignoresTerm: true,
		},
	]);
}

test.skipIf(skip)(
	"the owner stops a process with its children, and Force stop ends the survivors",
	async () => {
		seedTree();
		const soft = await treeAction(alice, "stop-tree", 7, { startTicks: 100 });
		expect(soft.statusCode).toBe(200);
		expect(soft.json()).toEqual({
			pid: 7,
			exited: false,
			signalled: 3,
			refused: 1,
			remaining: [{ pid: 11, startTicks: 320 }],
		});
		const hard = await treeAction(alice, "stop-tree", 7, {
			startTicks: 100,
			force: true,
			remaining: soft.json().remaining,
		});
		expect(hard.json()).toMatchObject({ exited: true, remaining: [] });
		expect((await audits()).map((row) => row.metadata)).toEqual(
			expect.arrayContaining([
				{ pid: 7, signal: "SIGTERM", exited: false, tree: true, signalled: 3 },
				{ pid: 7, signal: "SIGKILL", exited: true, tree: true, signalled: 1 },
			]),
		);
		const everything = JSON.stringify(await audits()) + JSON.stringify(lines);
		expect(everything).not.toContain("zzname");
		expect(everything).not.toContain("zzsecret");
	},
);

test.skipIf(skip)("the owner lowers a process tree's priority, audited", async () => {
	seedTree();
	const first = await treeAction(alice, "lower-priority", 7, { startTicks: 100 });
	expect(first.statusCode).toBe(200);
	expect(first.json()).toEqual({ pid: 7, lowered: 3, refused: 1 });
	const rows = await testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "workspace.process_priority_lowered")
		.execute();
	expect(rows.map((row) => row.metadata)).toEqual([{ pid: 7, lowered: 3 }]);
	// A body that names a nice value is refused: only the agent picks it.
	const asked = await treeAction(alice, "lower-priority", 7, {
		startTicks: 100,
		nice: -20,
	});
	expect(asked.statusCode).toBe(400);
});

test.skipIf(skip)(
	"tree actions keep the owner rule and pass the agent's refusals on",
	async () => {
		seedTree();
		for (const action of ["stop-tree", "lower-priority"] as const) {
			expect((await treeAction(bob, action, 7, { startTicks: 100 })).statusCode).toBe(
				404,
			);
			const changed = await treeAction(alice, action, 7, { startTicks: 101 });
			expect(changed.statusCode).toBe(409);
			expect(changed.json().code).toBe("PROCESS_CHANGED");
			const guarded = await treeAction(alice, action, 10, { startTicks: 310 });
			expect(guarded.statusCode).toBe(403);
		}
		expect(await audits()).toEqual([]);
	},
);

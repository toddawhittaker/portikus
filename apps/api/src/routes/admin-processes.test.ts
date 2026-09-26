/**
 * The administrator's process list and stop (ADR 0037; SPEC.md §20.1, §24.11;
 * docs/EPIC-21.md rulings 14 to 16). Admin-only; Refresh only writes a request
 * row; the stop goes through the agent's checked route, writes an audit row
 * and tells the student, and nothing names a process or its command line.
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
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";
import { ADMIN_STOP_NOTIFICATION_TITLE } from "./admin-processes.js";

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
		url: `/admin/workspaces/${id}/processes/${pid}/stop`,
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

function refresh(jar: CookieJar, id = workspaceId) {
	return app.inject({
		method: "POST",
		url: `/admin/workspaces/${id}/processes/refresh`,
		headers: csrfHeaders(jar, PUBLIC_URL),
	});
}

function read(jar: CookieJar, id = workspaceId) {
	return app.inject({
		method: "GET",
		url: `/admin/workspaces/${id}/processes`,
		headers: csrfHeaders(jar, PUBLIC_URL),
	});
}

async function ownerOf(id: string): Promise<string> {
	const row = await testDb.db
		.selectFrom("workspaces")
		.select("owner_user_id")
		.where("id", "=", id)
		.executeTakeFirstOrThrow();
	return row.owner_user_id;
}

async function notificationsFor(userId: string) {
	return testDb.db
		.selectFrom("notifications")
		.selectAll()
		.where("user_id", "=", userId)
		.execute();
}

test.skipIf(skip)("with no snapshot yet the read is empty", async () => {
	const response = await read(carol);
	expect(response.statusCode).toBe(200);
	expect(response.json()).toEqual({
		requestedAt: null,
		takenAt: null,
		processes: [],
		error: null,
	});
});

test.skipIf(skip)(
	"Refresh writes a request row and answers 202 without calling out",
	async () => {
		const response = await refresh(carol);
		expect(response.statusCode).toBe(202);
		const { requestedAt } = response.json();
		const row = await testDb.db
			.selectFrom("workspace_process_snapshots")
			.selectAll()
			.where("workspace_id", "=", workspaceId)
			.executeTakeFirstOrThrow();
		expect(row.requested_at.toISOString()).toBe(requestedAt);
		expect(row.taken_at).toBeNull();
		expect(agent.processes.get("")?.map((p) => p.pid)).toEqual([1, 7, 8]);
		const again = await refresh(carol);
		expect(again.statusCode).toBe(202);
		const after = await read(carol);
		expect(after.json().requestedAt).toBe(again.json().requestedAt);
		expect(after.json().takenAt).toBeNull();
	},
);

test.skipIf(skip)("the read returns what the worker wrote", async () => {
	const rows = [
		{
			pid: 7,
			uid: 1000,
			name: "zzname",
			startTicks: 100,
			cpuPercent: 90,
			residentBytes: 4096,
			protected: false,
		},
	];
	await testDb.db
		.insertInto("workspace_process_snapshots")
		.values({
			workspace_id: workspaceId,
			requested_at: "2026-09-26T10:00:00.000Z",
			taken_at: "2026-09-26T10:00:02.000Z",
			processes: JSON.stringify(rows),
		})
		.execute();
	expect((await read(carol)).json()).toEqual({
		requestedAt: "2026-09-26T10:00:00.000Z",
		takenAt: "2026-09-26T10:00:02.000Z",
		processes: rows,
		error: null,
	});
});

test.skipIf(skip)("a stored row carrying a command line is not passed on", async () => {
	await testDb.db
		.insertInto("workspace_process_snapshots")
		.values({
			workspace_id: workspaceId,
			requested_at: "2026-09-26T10:00:00.000Z",
			taken_at: "2026-09-26T10:00:02.000Z",
			processes: JSON.stringify([
				{
					pid: 7,
					uid: 1000,
					name: "zzname",
					startTicks: 1,
					cpuPercent: 1,
					residentBytes: 1,
					protected: false,
					commandLine: SECRET_LINE,
				},
			]),
		})
		.execute();
	const body = (await read(carol)).json();
	expect(body.processes).toEqual([]);
	expect(body.error).toBe("BAD_SNAPSHOT");
	expect(JSON.stringify(body)).not.toContain("zzsecret");
});

test.skipIf(skip)("students get 403 on every admin process route", async () => {
	for (const jar of [alice, bob]) {
		expect((await read(jar)).statusCode).toBe(403);
		expect((await refresh(jar)).statusCode).toBe(403);
		expect((await stop(jar, 7)).statusCode).toBe(403);
	}
	expect(agent.processes.get("")?.map((p) => p.pid)).toEqual([1, 7, 8]);
});

test.skipIf(skip)("a missing workspace is 404 and a stopped one 409", async () => {
	const missing = "00000000-0000-4000-8000-000000000000";
	expect((await read(carol, missing)).statusCode).toBe(404);
	expect((await refresh(carol, missing)).statusCode).toBe(404);
	expect((await stop(carol, 7, { startTicks: 100 }, missing)).statusCode).toBe(404);
	const stopped = await makeWorkspace(bob, false);
	const refused = await refresh(carol, stopped);
	expect(refused.statusCode).toBe(409);
	expect(refused.json().code).toBe("WORKSPACE_NOT_RUNNING");
	expect((await stop(carol, 7, { startTicks: 100 }, stopped)).statusCode).toBe(409);
});

test.skipIf(skip)(
	"an administrator's stop audits, tells the student, and names no process",
	async () => {
		const response = await stop(carol, 7);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ pid: 7, exited: true });
		const rows = await audits();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.metadata).toEqual({ pid: 7, signal: "SIGTERM", exited: true });
		const student = await ownerOf(workspaceId);
		expect(rows[0]?.actor).not.toBe(`user:${student}`);
		const notes = await notificationsFor(student);
		expect(notes).toHaveLength(1);
		expect(notes[0]?.title).toBe(ADMIN_STOP_NOTIFICATION_TITLE);
		expect(notes[0]?.tone).toBe("neutral");
		const everything =
			JSON.stringify(rows) + JSON.stringify(notes) + JSON.stringify(lines);
		expect(everything).not.toContain("zzname");
		expect(everything).not.toContain("zzsecret");
	},
);

test.skipIf(skip)("Force stop goes through the agent with SIGKILL", async () => {
	expect((await stop(carol, 8, { startTicks: 200 })).json()).toEqual({
		pid: 8,
		exited: false,
	});
	expect((await stop(carol, 8, { startTicks: 200, force: true })).json()).toEqual({
		pid: 8,
		exited: true,
	});
	expect((await audits()).map((row) => row.metadata)).toEqual(
		expect.arrayContaining([
			{ pid: 8, signal: "SIGTERM", exited: false },
			{ pid: 8, signal: "SIGKILL", exited: true },
		]),
	);
});

test.skipIf(skip)(
	"the agent's refusals pass through with no audit or notification",
	async () => {
		expect((await stop(carol, 99)).json().code).toBe("PROCESS_NOT_FOUND");
		expect((await stop(carol, 7, { startTicks: 101 })).json().code).toBe(
			"PROCESS_CHANGED",
		);
		const guarded = await stop(carol, 1, { startTicks: 1 });
		expect(guarded.statusCode).toBe(403);
		expect(guarded.json().code).toBe("PROCESS_PROTECTED");
		expect(await audits()).toEqual([]);
		expect(await notificationsFor(await ownerOf(workspaceId))).toEqual([]);
	},
);

test.skipIf(skip)("a bad pid or body is refused before the agent", async () => {
	for (const pid of ["0", "-1", "abc", "99999999999"]) {
		expect((await stop(carol, pid)).statusCode, pid).toBe(400);
	}
	expect((await stop(carol, 7, { startTicks: 100, extra: 1 })).statusCode).toBe(400);
	expect(agent.processes.get("")?.map((p) => p.pid)).toEqual([1, 7, 8]);
});

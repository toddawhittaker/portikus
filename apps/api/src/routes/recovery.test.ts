import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/**
 * Recovery points through the API (SPEC.md §15, ADR 0020): owner only,
 * a safety point before every restore, and the hooks on archive, delete and
 * a coding agent's session.
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "fake-agent-token";
const SLUG = "secret-plans";
const FILE = `${SLUG}/notes-about-exam.txt`;

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let workspaceId: string;
let projectId: string;

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
	agent.terminals.clear();
	agent.recoveryPoints.clear();
	agent.recoveryFull.clear();
	agent.recoveryDeletes.length = 0;
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
	await setState("running");
	const created = await app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/projects`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: { name: SLUG, source: "new" },
	});
	projectId = created.json().id;
	writeFile("first draft");
	return async () => {
		await app.close();
	};
});

async function setState(state: string) {
	await testDb.db
		.updateTable("workspaces")
		.set({
			state,
			agent_address: "127.0.0.1",
			agent_token: AGENT_TOKEN,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", workspaceId)
		.execute();
}

function writeFile(content: string) {
	agent.files.set(FILE, { type: "file", content: Buffer.from(content) });
}

function readFile(): string | undefined {
	const node = agent.files.get(FILE);
	return node?.type === "file" ? node.content.toString() : undefined;
}

const base = () => `/workspaces/${workspaceId}/projects/${projectId}/recovery-points`;

function list(jar: CookieJar) {
	return app.inject({
		method: "GET",
		url: base(),
		headers: { cookie: jar.cookieHeader() },
	});
}

function create(jar: CookieJar) {
	return app.inject({
		method: "POST",
		url: base(),
		headers: csrfHeaders(jar, PUBLIC_URL),
	});
}

function restore(
	jar: CookieJar,
	pointId: string,
	payload: Record<string, unknown> = {},
) {
	return app.inject({
		method: "POST",
		url: `${base()}/${pointId}/restore`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload,
	});
}

function pointRows() {
	return testDb.db
		.selectFrom("recovery_points")
		.selectAll()
		.orderBy("created_at")
		.execute();
}

test.skipIf(skip)("the owner creates a point and lists it with the usage", async () => {
	const created = await create(alice);
	expect(created.statusCode).toBe(201);
	const point = created.json();
	expect(point.reason).toBe("manual");
	expect(point.sizeBytes).toBe("first draft".length);

	const rows = await pointRows();
	expect(rows).toHaveLength(1);
	expect(rows[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
	expect(rows[0]?.workspace_id).toBe(workspaceId);
	const [row] = rows;
	if (!row) throw new Error("no point row");
	const days = (row.expires_at.getTime() - row.created_at.getTime()) / 86_400_000;
	expect(Math.round(days)).toBe(14);

	const listed = await list(alice);
	expect(listed.statusCode).toBe(200);
	expect(listed.json().points.map((p: { id: string }) => p.id)).toEqual([point.id]);
	expect(listed.json().usage).toEqual({
		usedBytes: "first draft".length,
		quotaBytes: 3 * 1024 ** 3,
	});
});

test.skipIf(skip)("another student and an administrator get 404", async () => {
	const pointId = (await create(alice)).json().id;
	for (const name of ["bob", "carol"]) {
		const jar = new CookieJar();
		await loginAs(app, name, jar);
		for (const response of [
			await list(jar),
			await create(jar),
			await restore(jar, pointId),
		]) {
			expect(response.statusCode).toBe(404);
			expect(response.json().code).toBe("WORKSPACE_NOT_FOUND");
		}
	}
	expect(await pointRows()).toHaveLength(1);
});

test.skipIf(skip)(
	"a stopped workspace lists its points but cannot make one",
	async () => {
		await create(alice);
		await setState("stopped");
		expect((await list(alice)).json().points).toHaveLength(1);
		const refused = await create(alice);
		expect(refused.statusCode).toBe(409);
		expect(refused.json().code).toBe("AGENT_UNAVAILABLE");
	},
);

test.skipIf(skip)("restore puts the files back after a safety point", async () => {
	const pointId = (await create(alice)).json().id;
	writeFile("ruined by an agent");

	const restored = await restore(alice, pointId);
	expect(restored.statusCode).toBe(204);
	expect(readFile()).toBe("first draft");

	const reasons = (await pointRows()).map((row) => row.reason);
	expect(reasons).toEqual(["manual", "before-restore"]);

	const audit = await testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "recovery.restored")
		.execute();
	expect(audit).toHaveLength(1);
	expect(audit[0]?.result).toBe("ok");
	expect(audit[0]?.target).toBe(projectId);
	expect(audit[0]?.metadata).toMatchObject({ pointId, reason: "manual" });
	// Ids and the reason only, never a file name or the folder (SPEC.md §24.11).
	const text = JSON.stringify(audit[0]);
	expect(text).not.toContain("notes-about-exam");
	expect(text).not.toContain(SLUG);
});

test.skipIf(skip)("restore is refused when the safety point fails", async () => {
	const pointId = (await create(alice)).json().id;
	writeFile("current work");
	agent.recoveryFull.add("");

	const refused = await restore(alice, pointId);
	expect(refused.statusCode).toBe(507);
	expect(refused.json().code).toBe("STORAGE_FULL");
	expect(readFile()).toBe("current work");

	// The student confirmed restoring without saving the current state.
	const allowed = await restore(alice, pointId, { skipSafetyPoint: true });
	expect(allowed.statusCode).toBe(204);
	expect(readFile()).toBe("first draft");
	expect((await pointRows()).map((row) => row.reason)).toEqual(["manual"]);
	const audit = await testDb.db
		.selectFrom("audit_events")
		.select("metadata")
		.where("action", "=", "recovery.restored")
		.executeTakeFirstOrThrow();
	expect(audit.metadata).toMatchObject({ safetyPointId: null });
});

test.skipIf(skip)(
	"skipSafetyPoint does not skip any failure but a full allowance",
	async () => {
		const pointId = (await create(alice)).json().id;
		writeFile("current work");
		// The directory has gone, so the safety point fails for another reason.
		agent.projects.delete(SLUG);

		const refused = await restore(alice, pointId, { skipSafetyPoint: true });
		expect(refused.statusCode).toBe(404);
		expect(refused.json().code).toBe("PROJECT_NOT_FOUND");
		expect(readFile()).toBe("current work");
	},
);

test.skipIf(skip)(
	"a point of another project, or a tampered one, is refused",
	async () => {
		const pointId = (await create(alice)).json().id;
		const other = (
			await app.inject({
				method: "POST",
				url: `/workspaces/${workspaceId}/projects`,
				headers: csrfHeaders(alice, PUBLIC_URL),
				payload: { name: "other", source: "new" },
			})
		).json().id;
		const wrongProject = await app.inject({
			method: "POST",
			url: `/workspaces/${workspaceId}/projects/${other}/recovery-points/${pointId}/restore`,
			headers: csrfHeaders(alice, PUBLIC_URL),
			payload: {},
		});
		expect(wrongProject.statusCode).toBe(404);
		expect(wrongProject.json().code).toBe("NOT_FOUND");

		await testDb.db
			.updateTable("recovery_points")
			.set({ sha256: "0".repeat(64) })
			.where("id", "=", pointId)
			.execute();
		writeFile("current work");
		const tampered = await restore(alice, pointId);
		expect(tampered.statusCode).toBe(422);
		expect(readFile()).toBe("current work");
		const audit = await testDb.db
			.selectFrom("audit_events")
			.select("result")
			.where("action", "=", "recovery.restored")
			.executeTakeFirstOrThrow();
		expect(audit.result).toBe("failed");
	},
);

test.skipIf(skip)("an unknown field in the restore body is refused", async () => {
	const pointId = (await create(alice)).json().id;
	const response = await restore(alice, pointId, { force: true });
	expect(response.statusCode).toBe(400);
});

function archive() {
	return app.inject({
		method: "PATCH",
		url: `/workspaces/${workspaceId}/projects/${projectId}`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: { state: "archived" },
	});
}

test.skipIf(skip)("archiving makes a before-archive point first", async () => {
	expect((await archive()).statusCode).toBe(200);
	expect((await pointRows()).map((row) => row.reason)).toEqual(["before-archive"]);
});

test.skipIf(skip)("archiving still succeeds when its point fails", async () => {
	agent.recoveryFull.add("");
	const archived = await archive();
	expect(archived.statusCode).toBe(200);
	expect(archived.json().state).toBe("archived");
	expect(await pointRows()).toHaveLength(0);
});

test.skipIf(skip)(
	"deleting a project removes its points and asks the agent to",
	async () => {
		await create(alice);
		const deleted = await app.inject({
			method: "DELETE",
			url: `/workspaces/${workspaceId}/projects/${projectId}`,
			headers: csrfHeaders(alice, PUBLIC_URL),
			payload: { slug: SLUG },
		});
		expect(deleted.statusCode).toBe(204);
		expect(agent.recoveryDeletes).toEqual([projectId]);
		expect(agent.recoveryPoints.size).toBe(0);
		expect(await pointRows()).toHaveLength(0);
	},
);

function createTerminal(payload: Record<string, unknown>) {
	return app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/terminals`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload,
	});
}

test.skipIf(skip)(
	"a coding agent's terminal carries its agent-session point",
	async () => {
		const created = await createTerminal({ projectId, agent: "claude" });
		expect(created.statusCode).toBe(201);
		const [point] = await pointRows();
		if (!point) throw new Error("no point row");
		expect(point.reason).toBe("agent-session");
		expect(created.json().recoveryPointId).toBe(point.id);
		const terminal = await testDb.db
			.selectFrom("terminals")
			.select("recovery_point_id")
			.where("id", "=", created.json().id)
			.executeTakeFirstOrThrow();
		expect(terminal.recovery_point_id).toBe(point.id);

		// The point is what "Restore to before this session" restores.
		writeFile("the agent's changes");
		expect((await restore(alice, point.id)).statusCode).toBe(204);
		expect(readFile()).toBe("first draft");
	},
);

test.skipIf(skip)("the agent session still launches when its point fails", async () => {
	agent.recoveryFull.add("");
	const created = await createTerminal({ projectId, agent: "codex" });
	expect(created.statusCode).toBe(201);
	expect(created.json().recoveryPointId).toBe(null);
});

test.skipIf(skip)("a plain terminal makes no point", async () => {
	const created = await createTerminal({ projectId });
	expect(created.statusCode).toBe(201);
	expect(created.json().recoveryPointId).toBe(null);
	expect(await pointRows()).toHaveLength(0);
});

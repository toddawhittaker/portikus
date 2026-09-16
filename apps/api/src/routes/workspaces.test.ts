import type { ApiConfig } from "@portikus/config";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { buildServer } from "../server.js";

const skip = !hasTestDb();
let testDb: TestDb;

const testConfig: ApiConfig = {
	NODE_ENV: "test",
	PORT: 3000,
	DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
	PRESENCE_TTL_SECONDS: 60,
	WORKSPACE_HOME_SIZE_GIB: 25,
	WORKSPACE_DOCKER_SIZE_GIB: 20,
};

function makeApp() {
	return buildServer({ db: testDb.db, config: testConfig });
}

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
});

test.skipIf(skip)("POST /workspaces creates a workspace and returns 201", async () => {
	const app = makeApp();
	const res = await app.inject({
		method: "POST",
		url: "/workspaces",
		payload: { ownerUserId: "user-1" },
	});

	expect(res.statusCode).toBe(201);
	const body = res.json();
	expect(body.ownerUserId).toBe("user-1");
	expect(body.state).toBe("provisioning");
	expect(body.desiredState).toBe("stopped");
	expect(body.incusInstanceName).toMatch(/^ws-[a-f0-9]{24}$/);
	expect(body.quotaConfig).toEqual({ homeGiB: 25, dockerGiB: 20 });

	await app.close();
});

test.skipIf(skip)("POST /workspaces is idempotent by owner", async () => {
	const app = makeApp();

	const first = await app.inject({
		method: "POST",
		url: "/workspaces",
		payload: { ownerUserId: "user-1" },
	});
	expect(first.statusCode).toBe(201);

	const second = await app.inject({
		method: "POST",
		url: "/workspaces",
		payload: { ownerUserId: "user-1" },
	});
	expect(second.statusCode).toBe(200);
	expect(second.json().id).toBe(first.json().id);

	await app.close();
});

test.skipIf(skip)("GET /workspaces/:id returns the workspace", async () => {
	const app = makeApp();

	const create = await app.inject({
		method: "POST",
		url: "/workspaces",
		payload: { ownerUserId: "user-get" },
	});
	const id = create.json().id;

	const res = await app.inject({
		method: "GET",
		url: `/workspaces/${id}`,
	});
	expect(res.statusCode).toBe(200);
	expect(res.json().id).toBe(id);

	await app.close();
});

test.skipIf(skip)("GET /workspaces/:id returns 404 for nonexistent", async () => {
	const app = makeApp();
	const res = await app.inject({
		method: "GET",
		url: "/workspaces/00000000-0000-0000-0000-000000000000",
	});
	expect(res.statusCode).toBe(404);
	expect(res.json().code).toBe("WORKSPACE_NOT_FOUND");

	await app.close();
});

test.skipIf(skip)("GET /workspaces/:id returns 400 for invalid uuid", async () => {
	const app = makeApp();
	const res = await app.inject({
		method: "GET",
		url: "/workspaces/not-a-uuid",
	});
	expect(res.statusCode).toBe(400);
	expect(res.json().code).toBe("VALIDATION_FAILED");

	await app.close();
});

test.skipIf(skip)("POST /workspaces/:id/connections sets desired running", async () => {
	const app = makeApp();

	const ws = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			payload: { ownerUserId: "user-conn" },
		})
	).json();

	const connRes = await app.inject({
		method: "POST",
		url: `/workspaces/${ws.id}/connections`,
	});
	expect(connRes.statusCode).toBe(201);
	const conn = connRes.json();
	expect(conn.connectionId).toBeTruthy();
	expect(conn.workspaceId).toBe(ws.id);

	// Workspace should now have desired_state running.
	const get = (
		await app.inject({
			method: "GET",
			url: `/workspaces/${ws.id}`,
		})
	).json();
	expect(get.desiredState).toBe("running");

	await app.close();
});

test.skipIf(skip)("heartbeat refreshes last_seen_at", async () => {
	const app = makeApp();

	const ws = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			payload: { ownerUserId: "user-hb" },
		})
	).json();

	const conn = (
		await app.inject({
			method: "POST",
			url: `/workspaces/${ws.id}/connections`,
		})
	).json();

	const hb = await app.inject({
		method: "POST",
		url: `/workspaces/${ws.id}/connections/${conn.connectionId}/heartbeat`,
	});
	expect(hb.statusCode).toBe(204);

	await app.close();
});

test.skipIf(skip)("heartbeat returns 404 for unknown connection", async () => {
	const app = makeApp();

	const ws = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			payload: { ownerUserId: "user-hb404" },
		})
	).json();

	const hb = await app.inject({
		method: "POST",
		url: `/workspaces/${ws.id}/connections/00000000-0000-0000-0000-000000000000/heartbeat`,
	});
	expect(hb.statusCode).toBe(404);
	expect(hb.json().code).toBe("CONNECTION_NOT_FOUND");

	await app.close();
});

test.skipIf(skip)("disconnect leaves state untouched", async () => {
	const app = makeApp();

	const ws = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			payload: { ownerUserId: "user-dc" },
		})
	).json();

	const conn = (
		await app.inject({
			method: "POST",
			url: `/workspaces/${ws.id}/connections`,
		})
	).json();

	const del = await app.inject({
		method: "DELETE",
		url: `/workspaces/${ws.id}/connections/${conn.connectionId}`,
	});
	expect(del.statusCode).toBe(204);

	// State stays provisioning; desired stays running (set by connect).
	const get = (
		await app.inject({
			method: "GET",
			url: `/workspaces/${ws.id}`,
		})
	).json();
	expect(get.state).toBe("provisioning");

	await app.close();
});

test.skipIf(skip)("activeConnections excludes stale rows", async () => {
	const app = makeApp();

	const ws = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			payload: { ownerUserId: "user-stale" },
		})
	).json();

	// Insert a stale connection directly.
	const staleTime = new Date(
		Date.now() - (testConfig.PRESENCE_TTL_SECONDS + 10) * 1000,
	).toISOString();

	await testDb.db
		.insertInto("workspace_connections")
		.values({
			id: crypto.randomUUID(),
			workspace_id: ws.id,
			last_seen_at: staleTime,
		})
		.execute();

	// Insert a fresh connection via API.
	await app.inject({
		method: "POST",
		url: `/workspaces/${ws.id}/connections`,
	});

	const get = (
		await app.inject({
			method: "GET",
			url: `/workspaces/${ws.id}`,
		})
	).json();

	// Only the fresh connection counts.
	expect(get.activeConnections).toBe(1);

	await app.close();
});

test.skipIf(skip)("start/stop/restart set desired_state and write audit", async () => {
	const app = makeApp();

	const ws = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			payload: { ownerUserId: "user-actions" },
		})
	).json();

	const start = await app.inject({
		method: "POST",
		url: `/workspaces/${ws.id}/start`,
	});
	expect(start.statusCode).toBe(202);

	let get = (await app.inject({ method: "GET", url: `/workspaces/${ws.id}` })).json();
	expect(get.desiredState).toBe("running");

	const stop = await app.inject({
		method: "POST",
		url: `/workspaces/${ws.id}/stop`,
	});
	expect(stop.statusCode).toBe(202);

	get = (await app.inject({ method: "GET", url: `/workspaces/${ws.id}` })).json();
	expect(get.desiredState).toBe("stopped");

	const restart = await app.inject({
		method: "POST",
		url: `/workspaces/${ws.id}/restart`,
	});
	expect(restart.statusCode).toBe(202);

	get = (await app.inject({ method: "GET", url: `/workspaces/${ws.id}` })).json();
	expect(get.desiredState).toBe("restarting");

	// Check audit rows exist.
	const audits = await testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("target", "=", ws.id)
		.execute();

	const actions = audits.map((a) => a.action);
	expect(actions).toContain("workspace.provision_requested");
	expect(actions).toContain("workspace.start_requested");
	expect(actions).toContain("workspace.stop_requested");
	expect(actions).toContain("workspace.restart_requested");

	await app.close();
});

test.skipIf(skip)("start returns 404 for nonexistent workspace", async () => {
	const app = makeApp();
	const res = await app.inject({
		method: "POST",
		url: "/workspaces/00000000-0000-0000-0000-000000000000/start",
	});
	expect(res.statusCode).toBe(404);
	expect(res.json().code).toBe("WORKSPACE_NOT_FOUND");

	await app.close();
});

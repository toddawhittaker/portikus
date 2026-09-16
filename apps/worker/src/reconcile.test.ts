import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ControllerClientError } from "./controller-client.js";
import { FakeControllerClient } from "./fake-controller.js";
import { type ReconcileConfig, reconcile } from "./reconcile.js";

const skip = !hasTestDb();

let tdb: TestDb;
const fake = new FakeControllerClient();

const cfg: ReconcileConfig = {
	PRESENCE_TTL_SECONDS: 60,
	SHUTDOWN_GRACE_SECONDS: 600,
	START_TIMEOUT_SECONDS: 60,
	STOP_TIMEOUT_SECONDS: 30,
	STATUS_REFRESH_SECONDS: 15,
	WORKSPACE_HOME_SIZE_GIB: 25,
	WORKSPACE_DOCKER_SIZE_GIB: 20,
};

beforeAll(async () => {
	if (skip) return;
	tdb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await tdb.close();
});

beforeEach(async () => {
	if (skip) return;
	await tdb.truncate();
	fake.calls = [];
	fake.createResult = {
		created: true,
		imageFingerprint: "abc123",
		quota: { homeGiB: 25, dockerGiB: 20 },
	};
	fake.startResult = { ipv4: "10.0.0.2" };
	fake.stopResult = { forced: false };
	fake.listResult = [];
});

/** Insert a workspace row and return its id. */
async function insertWorkspace(
	overrides: Record<string, unknown> = {},
): Promise<string> {
	const defaults = {
		owner_user_id: `user-${Math.random().toString(36).slice(2, 8)}`,
		incus_instance_name: `ws-${Math.random().toString(36).slice(2, 14)}`,
		state: "stopped",
		desired_state: "stopped",
	};
	const row = { ...defaults, ...overrides };
	const result = await tdb.db
		.insertInto("workspaces")
		.values(row)
		.returning("id")
		.executeTakeFirstOrThrow();
	return result.id;
}

/** Insert a connection for a workspace. */
async function insertConnection(
	workspaceId: string,
	lastSeenAt?: Date,
): Promise<string> {
	const result = await tdb.db
		.insertInto("workspace_connections")
		.values({
			workspace_id: workspaceId,
			last_seen_at: (lastSeenAt ?? new Date()).toISOString(),
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return result.id;
}

/** Get workspace by id. */
async function getWorkspace(id: string) {
	return tdb.db
		.selectFrom("workspaces")
		.selectAll()
		.where("id", "=", id)
		.executeTakeFirstOrThrow();
}

/** Get audit events for a workspace. */
async function getAudits(target: string) {
	return tdb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("target", "=", target)
		.execute();
}

// --- Acceptance criteria ---

test.skipIf(skip)("connect -> sweep -> start called -> running", async () => {
	const id = await insertWorkspace({
		state: "stopped",
		desired_state: "running",
	});
	await insertConnection(id);
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now);

	const ws = await getWorkspace(id);
	expect(ws.state).toBe("running");
	expect(fake.calls.some((c) => c.method === "start")).toBe(true);
	const audits = await getAudits(id);
	expect(audits.some((a) => a.action === "workspace.start")).toBe(true);
});

test.skipIf(skip)("disconnect -> sweep -> deadline set, still running", async () => {
	const id = await insertWorkspace({
		state: "running",
		desired_state: "running",
	});
	// No connections.
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now);

	const ws = await getWorkspace(id);
	expect(ws.state).toBe("running");
	expect(ws.shutdown_deadline).not.toBeNull();
	const deadline = new Date(ws.shutdown_deadline as unknown as string).getTime();
	const expected = now.getTime() + cfg.SHUTDOWN_GRACE_SECONDS * 1000;
	expect(Math.abs(deadline - expected)).toBeLessThan(2000);
});

test.skipIf(skip)("reconnect -> sweep -> deadline cleared", async () => {
	const now = new Date();
	const deadline = new Date(now.getTime() + cfg.SHUTDOWN_GRACE_SECONDS * 1000);
	const id = await insertWorkspace({
		state: "running",
		desired_state: "running",
		shutdown_deadline: deadline.toISOString(),
	});
	await insertConnection(id);

	await reconcile(tdb.db, fake, cfg, now);

	const ws = await getWorkspace(id);
	expect(ws.state).toBe("running");
	expect(ws.shutdown_deadline).toBeNull();
});

test.skipIf(skip)(
	"deadline passed -> sweep -> stop called -> stopped with audit",
	async () => {
		const now = new Date();
		const pastDeadline = new Date(now.getTime() - 1000);
		const id = await insertWorkspace({
			state: "running",
			desired_state: "running",
			shutdown_deadline: pastDeadline.toISOString(),
		});
		// No connections.

		await reconcile(tdb.db, fake, cfg, now);

		const ws = await getWorkspace(id);
		expect(ws.state).toBe("stopped");
		expect(ws.desired_state).toBe("stopped");
		expect(fake.calls.some((c) => c.method === "stop")).toBe(true);
		const audits = await getAudits(id);
		expect(audits.some((a) => a.action === "workspace.stop")).toBe(true);
	},
);

test.skipIf(skip)("forced stop writes workspace.force_stop audit", async () => {
	fake.stopResult = { forced: true };
	const now = new Date();
	const id = await insertWorkspace({
		state: "running",
		desired_state: "stopped",
	});

	await reconcile(tdb.db, fake, cfg, now);

	const ws = await getWorkspace(id);
	expect(ws.state).toBe("stopped");
	const audits = await getAudits(id);
	expect(audits.some((a) => a.action === "workspace.stop")).toBe(true);
	expect(audits.some((a) => a.action === "workspace.force_stop")).toBe(true);
});

test.skipIf(skip)("provisioning -> create -> stopped", async () => {
	const id = await insertWorkspace({ state: "provisioning" });
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now);

	const ws = await getWorkspace(id);
	expect(ws.state).toBe("stopped");
	expect(ws.image_version).toBe("abc123");
	expect(fake.calls.some((c) => c.method === "create")).toBe(true);
});

test.skipIf(skip)("create failure -> error with user-terms message", async () => {
	fake.createResult = new ControllerClientError("STORAGE_FULL", "no space");
	const id = await insertWorkspace({ state: "provisioning" });
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now);

	const ws = await getWorkspace(id);
	expect(ws.state).toBe("error");
	expect(ws.error_code).toBe("STORAGE_FULL");
	expect(ws.error_message).toContain("storage is full");
});

test.skipIf(skip)(
	"restart flow: running -> stopping -> stopped -> desired running -> starting -> running",
	async () => {
		const id = await insertWorkspace({
			state: "running",
			desired_state: "restarting",
		});
		const now = new Date();

		// First sweep: running -> stopping -> stopped (desired set to running).
		await reconcile(tdb.db, fake, cfg, now);
		let ws = await getWorkspace(id);
		expect(ws.state).toBe("stopped");
		expect(ws.desired_state).toBe("running");

		// Second sweep: stopped with desired running -> starting -> running.
		await reconcile(tdb.db, fake, cfg, now);
		ws = await getWorkspace(id);
		expect(ws.state).toBe("running");
	},
);

test.skipIf(skip)(
	"drift: instance Stopped while row running -> stopped with observed audit",
	async () => {
		const id = await insertWorkspace({
			state: "running",
			desired_state: "running",
			incus_instance_name: "ws-drift-test",
		});
		// Add a connection so the deadline logic does not interfere.
		await insertConnection(id);
		fake.listResult = [{ name: "ws-drift-test", status: "Stopped", ipv4: null }];
		const now = new Date();

		// Force refresh by passing null lastRefreshAt.
		await reconcile(tdb.db, fake, cfg, now, null);

		const ws = await getWorkspace(id);
		expect(ws.state).toBe("stopped");
		const audits = await getAudits(id);
		expect(audits.some((a) => a.action === "workspace.observed_stopped")).toBe(true);
	},
);

test.skipIf(skip)("stale starting row resolved from list", async () => {
	const id = await insertWorkspace({
		state: "starting",
		desired_state: "running",
		incus_instance_name: "ws-stale-start",
	});
	fake.listResult = [{ name: "ws-stale-start", status: "Running", ipv4: "10.0.0.5" }];
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now, null);

	const ws = await getWorkspace(id);
	expect(ws.state).toBe("running");
});

test.skipIf(skip)("compare-and-set skips a row changed underneath", async () => {
	const id = await insertWorkspace({
		state: "stopped",
		desired_state: "running",
	});
	// Change state and desired_state underneath before the sweep.
	// Set desired stopped so the error retry path does not fire either.
	await tdb.db
		.updateTable("workspaces")
		.set({ state: "error", desired_state: "stopped" })
		.where("id", "=", id)
		.execute();

	const now = new Date();
	await reconcile(tdb.db, fake, cfg, now);

	// Should not have called start because CAS failed.
	const ws = await getWorkspace(id);
	expect(ws.state).toBe("error");
	expect(fake.calls.some((c) => c.method === "start")).toBe(false);
});

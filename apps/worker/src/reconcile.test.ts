import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { KyselyPlugin, PluginTransformQueryArgs, RootOperationNode } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ControllerClientError } from "./controller-client.js";
import { FakeControllerClient } from "./fake-controller.js";
import { doStop, type ReconcileConfig, reconcile } from "./reconcile.js";

/** Workspace labels are unique, so each test row needs its own. */
let labelCounter = 0;
function testLabel(): string {
	return `ws-test-${++labelCounter}`;
}

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
	WORKSPACE_RECOVERY_SIZE_GIB: 3,
	PREVIEW_SUFFIX: "preview.portikus.example.edu",
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
	await setGlobalGrace(cfg.SHUTDOWN_GRACE_SECONDS);
});

/** Set (or insert) the platform-wide grace period. */
async function setGlobalGrace(seconds: number): Promise<void> {
	await tdb.db
		.insertInto("settings")
		.values({ id: 1, shutdown_grace_seconds: seconds })
		.onConflict((oc) =>
			oc.column("id").doUpdateSet({ shutdown_grace_seconds: seconds }),
		)
		.execute();
}

/** Insert a workspace row and return its id. */
async function insertWorkspace(
	overrides: Record<string, unknown> = {},
): Promise<string> {
	const defaults = {
		label: testLabel(),
		owner_user_id: await insertTestUser(tdb.db),
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

	await reconcile(tdb.db, fake, cfg, now, now);

	const ws = await getWorkspace(id);
	expect(ws.state).toBe("running");
	expect(fake.calls.some((c) => c.method === "start")).toBe(true);
	// The start request carries the preview host suffix (issue #263).
	const startCall = fake.calls.find((c) => c.method === "start");
	expect(startCall?.args[1]).toMatchObject({
		previewHostSuffix: "preview.portikus.example.edu",
		timezone: "America/New_York",
	});
	const audits = await getAudits(id);
	expect(audits.some((a) => a.action === "workspace.start")).toBe(true);
});

/** Issue #287: the container starts in the zone its owner chose. */
test.skipIf(skip)("the start request carries the owner's timezone", async () => {
	const ownerId = await insertTestUser(tdb.db);
	await tdb.db
		.updateTable("users")
		.set({ editor_settings: JSON.stringify({ timezone: "Europe/Berlin" }) })
		.where("id", "=", ownerId)
		.execute();
	const id = await insertWorkspace({
		owner_user_id: ownerId,
		state: "stopped",
		desired_state: "running",
	});
	await insertConnection(id);
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now, now);

	const startCall = fake.calls.find((c) => c.method === "start");
	expect(startCall?.args[1]).toMatchObject({ timezone: "Europe/Berlin" });
});

test.skipIf(skip)("disconnect -> sweep -> deadline set, still running", async () => {
	const id = await insertWorkspace({
		state: "running",
		desired_state: "running",
	});
	// No connections.
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now, now);

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

	await reconcile(tdb.db, fake, cfg, now, now);

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
			disconnected_at: new Date(
				now.getTime() - (cfg.SHUTDOWN_GRACE_SECONDS + 1) * 1000,
			).toISOString(),
		});
		// No connections.

		await reconcile(tdb.db, fake, cfg, now, now);

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

	await reconcile(tdb.db, fake, cfg, now, now);

	const ws = await getWorkspace(id);
	expect(ws.state).toBe("stopped");
	const audits = await getAudits(id);
	expect(audits.some((a) => a.action === "workspace.stop")).toBe(true);
	expect(audits.some((a) => a.action === "workspace.force_stop")).toBe(true);
});

test.skipIf(skip)("provisioning -> create -> stopped", async () => {
	const id = await insertWorkspace({ state: "provisioning" });
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now, now);

	const ws = await getWorkspace(id);
	expect(ws.state).toBe("stopped");
	expect(ws.image_version).toBe("abc123");
	expect(fake.calls.some((c) => c.method === "create")).toBe(true);
});

test.skipIf(skip)("create failure -> error with user-terms message", async () => {
	fake.createResult = new ControllerClientError("STORAGE_FULL", "no space");
	const id = await insertWorkspace({ state: "provisioning" });
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now, now);

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
		await reconcile(tdb.db, fake, cfg, now, now);
		let ws = await getWorkspace(id);
		expect(ws.state).toBe("stopped");
		expect(ws.desired_state).toBe("running");

		// Second sweep: stopped with desired running -> starting -> running.
		await reconcile(tdb.db, fake, cfg, now, now);
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
	await reconcile(tdb.db, fake, cfg, now, now);

	// Should not have called start because CAS failed.
	const ws = await getWorkspace(id);
	expect(ws.state).toBe("error");
	expect(fake.calls.some((c) => c.method === "start")).toBe(false);
});

// --- Security and code review regressions ---

test.skipIf(skip)(
	"forced stop is audited even when the row already moved to stopped",
	async () => {
		fake.stopResult = { forced: true };
		const now = new Date();
		const id = await insertWorkspace({
			state: "stopped",
			desired_state: "stopped",
			incus_instance_name: "ws-already-stopped",
		});

		await doStop(
			tdb.db,
			fake,
			cfg,
			{ id, incus_instance_name: "ws-already-stopped" },
			now,
		);

		const audits = await getAudits(id);
		expect(audits.some((a) => a.action === "workspace.stop")).toBe(true);
		expect(audits.some((a) => a.action === "workspace.force_stop")).toBe(true);
	},
);

test.skipIf(skip)("an unreachable controller is reported once per streak", async () => {
	fake.listResult = new ControllerClientError("INCUS_UNAVAILABLE", "socket down");
	const id = await insertWorkspace({
		state: "running",
		desired_state: "running",
		incus_instance_name: "ws-unreachable",
	});
	await insertConnection(id);
	const now = new Date();

	const first = await reconcile(tdb.db, fake, cfg, now, null);
	expect(first.controllerUnreachable).toBe(true);
	expect(first.refreshError?.code).toBe("INCUS_UNAVAILABLE");

	// The row keeps its state: an unreachable controller is not an error
	// about the workspace itself.
	expect((await getWorkspace(id)).state).toBe("running");

	const unreachableAudits = await tdb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "controller.unreachable")
		.execute();
	expect(unreachableAudits).toHaveLength(1);

	// Second failure in the same streak does not write another row.
	const later = new Date(now.getTime() + cfg.STATUS_REFRESH_SECONDS * 1000);
	await reconcile(tdb.db, fake, cfg, later, first.lastRefreshAt, true);
	const stillOne = await tdb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "controller.unreachable")
		.execute();
	expect(stillOne).toHaveLength(1);
});

test.skipIf(skip)("a connect during a stop is not overwritten", async () => {
	const id = await insertWorkspace({
		state: "stopping",
		desired_state: "stopped",
		incus_instance_name: "ws-connect-during-stop",
	});
	const now = new Date();

	// The connect lands while the stop is in flight.
	await insertConnection(id);
	await tdb.db
		.updateTable("workspaces")
		.set({ desired_state: "running" })
		.where("id", "=", id)
		.execute();

	await doStop(
		tdb.db,
		fake,
		cfg,
		{ id, incus_instance_name: "ws-connect-during-stop" },
		now,
	);

	let ws = await getWorkspace(id);
	expect(ws.state).toBe("stopped");
	expect(ws.desired_state).toBe("running");

	// The next sweep starts it again.
	fake.listResult = [{ name: "ws-connect-during-stop", status: "Stopped", ipv4: null }];
	await reconcile(tdb.db, fake, cfg, new Date(now.getTime() + 1000), now);
	ws = await getWorkspace(id);
	expect(ws.state).toBe("running");
});

test.skipIf(skip)(
	"a connect after the deadline check keeps the workspace wanted",
	async () => {
		const now = new Date();
		const id = await insertWorkspace({
			state: "running",
			desired_state: "running",
			incus_instance_name: "ws-deadline-race",
			shutdown_deadline: new Date(now.getTime() - 1000).toISOString(),
			disconnected_at: new Date(
				now.getTime() - (cfg.SHUTDOWN_GRACE_SECONDS + 1) * 1000,
			).toISOString(),
		});

		// Deadline pass moves it to stopping and stops it.
		await reconcile(tdb.db, fake, cfg, now, now);
		expect((await getWorkspace(id)).state).toBe("stopped");

		// A connect arriving now must bring it back up on the next sweep.
		await insertConnection(id);
		await tdb.db
			.updateTable("workspaces")
			.set({ desired_state: "running" })
			.where("id", "=", id)
			.execute();
		await reconcile(tdb.db, fake, cfg, new Date(now.getTime() + 1000), now);
		expect((await getWorkspace(id)).state).toBe("running");
	},
);

test.skipIf(skip)(
	"a tracked instance missing from the list becomes an error",
	async () => {
		const id = await insertWorkspace({
			state: "running",
			desired_state: "running",
			incus_instance_name: "ws-vanished",
		});
		await insertConnection(id);
		fake.listResult = [];
		const now = new Date();

		await reconcile(tdb.db, fake, cfg, now, null);

		const ws = await getWorkspace(id);
		expect(ws.state).toBe("error");
		expect(ws.error_code).toBe("INSTANCE_MISSING");
		const audits = await getAudits(id);
		expect(audits.some((a) => a.action === "workspace.instance_missing")).toBe(true);
	},
);

test.skipIf(skip)("restart on a stopped workspace starts it", async () => {
	const id = await insertWorkspace({
		state: "stopped",
		desired_state: "restarting",
	});
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now, now);

	const ws = await getWorkspace(id);
	expect(ws.state).toBe("running");
	expect(ws.desired_state).toBe("running");
});

test.skipIf(skip)("a failed start is audited with the controller message", async () => {
	fake.startResult = new ControllerClientError("STORAGE_FULL", "pool is full");
	const id = await insertWorkspace({
		state: "stopped",
		desired_state: "running",
	});
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now, now);

	const audits = await getAudits(id);
	const failed = audits.find((a) => a.action === "workspace.start_failed");
	expect(failed).toBeDefined();
	expect(JSON.stringify(failed?.metadata)).toContain("pool is full");
	// The user-facing message stays in user terms.
	expect((await getWorkspace(id)).error_message).toContain("storage is full");
});

test.skipIf(skip)("an errored workspace is not retried every second", async () => {
	const now = new Date();
	const id = await insertWorkspace({
		state: "error",
		desired_state: "running",
		error_code: "STORAGE_FULL",
		updated_at: now.toISOString(),
	});

	await reconcile(tdb.db, fake, cfg, now, now);
	expect(fake.calls.some((c) => c.method === "start")).toBe(false);

	const later = new Date(now.getTime() + 11000);
	await reconcile(tdb.db, fake, cfg, later, later);
	expect(fake.calls.some((c) => c.method === "start")).toBe(true);
	expect((await getWorkspace(id)).state).toBe("running");
});

// --- Agent token, agent address, and terminal lifecycle (SPEC 9.7, 23.5) ---

/** Insert a terminal row and return its id. */
async function insertTerminal(
	workspaceId: string,
	endedAt: Date | null = null,
): Promise<string> {
	const row = await tdb.db
		.insertInto("terminals")
		.values({
			workspace_id: workspaceId,
			name: "terminal",
			cwd: "/home/student",
			ended_at: endedAt ? endedAt.toISOString() : null,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

async function getTerminal(id: string) {
	return tdb.db
		.selectFrom("terminals")
		.selectAll()
		.where("id", "=", id)
		.executeTakeFirstOrThrow();
}

test.skipIf(skip)(
	"the agent token is rotated on each start, and the request carries the current value",
	async () => {
		const id = await insertWorkspace({ state: "stopped", desired_state: "running" });
		const now = new Date();

		await reconcile(tdb.db, fake, cfg, now, now);
		const first = (await getWorkspace(id)).agent_token;
		expect(first).toMatch(/^[0-9a-f]{64}$/);

		// Stop it and start it again: the token must be a fresh one.
		await tdb.db
			.updateTable("workspaces")
			.set({ state: "stopped", desired_state: "running" })
			.where("id", "=", id)
			.execute();
		const later = new Date(now.getTime() + 1000);
		await reconcile(tdb.db, fake, cfg, later, later);

		const second = (await getWorkspace(id)).agent_token;
		expect(second).toMatch(/^[0-9a-f]{64}$/);
		expect(second).not.toBe(first);

		const starts = fake.calls.filter((c) => c.method === "start");
		expect(starts).toHaveLength(2);
		expect(starts[0]?.args[1]).toMatchObject({
			timeoutSeconds: cfg.START_TIMEOUT_SECONDS,
			agentToken: first,
		});
		expect(starts[1]?.args[1]).toMatchObject({
			timeoutSeconds: cfg.START_TIMEOUT_SECONDS,
			agentToken: second,
		});
	},
);

test.skipIf(skip)("a successful start records the agent address", async () => {
	fake.startResult = { ipv4: "10.200.0.44" };
	const id = await insertWorkspace({ state: "stopped", desired_state: "running" });
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now, now);

	expect((await getWorkspace(id)).agent_address).toBe("10.200.0.44");
});

test.skipIf(skip)("the drift refresh updates a changed agent address", async () => {
	const id = await insertWorkspace({
		state: "running",
		agent_address: "10.200.0.44",
	});
	const ws = await getWorkspace(id);
	fake.listResult = [
		{
			name: ws.incus_instance_name as string,
			status: "Running",
			ipv4: "10.200.0.99",
		},
	];
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now, null);

	expect((await getWorkspace(id)).agent_address).toBe("10.200.0.99");
});

test.skipIf(skip)(
	"the grace deadline ends open terminals but leaves ended ones",
	async () => {
		const now = new Date();
		const past = new Date(now.getTime() - 1000);
		const id = await insertWorkspace({
			state: "running",
			desired_state: "running",
			shutdown_deadline: past.toISOString(),
			disconnected_at: new Date(
				now.getTime() - (cfg.SHUTDOWN_GRACE_SECONDS + 1) * 1000,
			).toISOString(),
		});
		const open = await insertTerminal(id);
		const alreadyEnded = await insertTerminal(id, past);

		await reconcile(tdb.db, fake, cfg, now, now);

		expect((await getTerminal(open)).ended_at).not.toBeNull();
		const ended = await getTerminal(alreadyEnded);
		expect(new Date(ended.ended_at as unknown as string).getTime()).toBe(
			past.getTime(),
		);
	},
);

test.skipIf(skip)("an explicit stop ends open terminals", async () => {
	const id = await insertWorkspace({ state: "running", desired_state: "stopped" });
	const open = await insertTerminal(id);
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now, now);

	expect((await getTerminal(open)).ended_at).not.toBeNull();
});

// --- Live grace period settings (SPEC.md §6.4) ---

/** Insert a running workspace owned by a fresh user; returns both ids. */
async function runningWorkspace(
	userOverrides: { shutdown_grace_seconds?: number | null } = {},
): Promise<{ id: string; ownerId: string }> {
	const ownerId = await insertTestUser(tdb.db, userOverrides);
	const id = await insertWorkspace({
		state: "running",
		desired_state: "running",
		label: testLabel(),
		owner_user_id: ownerId,
	});
	return { id, ownerId };
}

function deadlineMs(value: unknown): number {
	return new Date(value as string).getTime();
}

test.skipIf(skip)("a global grace of 0 never arms a deadline", async () => {
	await setGlobalGrace(0);
	const { id } = await runningWorkspace();
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now, now);

	const ws = await getWorkspace(id);
	expect(ws.state).toBe("running");
	expect(ws.disconnected_at).not.toBeNull();
	expect(ws.shutdown_deadline).toBeNull();
});

test.skipIf(skip)("setting the grace to 0 clears an armed deadline", async () => {
	const { id } = await runningWorkspace();
	const now = new Date();
	await reconcile(tdb.db, fake, cfg, now, now);
	expect((await getWorkspace(id)).shutdown_deadline).not.toBeNull();

	await setGlobalGrace(0);
	await reconcile(tdb.db, fake, cfg, new Date(now.getTime() + 1000), now);

	const ws = await getWorkspace(id);
	expect(ws.state).toBe("running");
	expect(ws.shutdown_deadline).toBeNull();
});

test.skipIf(skip)("raising the grace moves the deadline forward", async () => {
	const { id } = await runningWorkspace();
	const now = new Date();
	await reconcile(tdb.db, fake, cfg, now, now);
	const first = deadlineMs((await getWorkspace(id)).shutdown_deadline);

	await setGlobalGrace(1200);
	await reconcile(tdb.db, fake, cfg, new Date(now.getTime() + 1000), now);

	const second = deadlineMs((await getWorkspace(id)).shutdown_deadline);
	expect(second - first).toBe(600_000);
});

test.skipIf(skip)(
	"lowering the grace into the past stops the workspace on that tick",
	async () => {
		const { id } = await runningWorkspace();
		const now = new Date();
		await reconcile(tdb.db, fake, cfg, now, now);

		await setGlobalGrace(60);
		const later = new Date(now.getTime() + 120_000);
		await reconcile(tdb.db, fake, cfg, later, later);

		const ws = await getWorkspace(id);
		expect(ws.state).toBe("stopped");
		expect(fake.calls.some((c) => c.method === "stop")).toBe(true);
	},
);

test.skipIf(skip)(
	"an owner override of 0 keeps that workspace up while another stops",
	async () => {
		const forever = await runningWorkspace({ shutdown_grace_seconds: 0 });
		const mortal = await runningWorkspace();
		const now = new Date();

		await reconcile(tdb.db, fake, cfg, now, now);
		expect((await getWorkspace(forever.id)).shutdown_deadline).toBeNull();

		const later = new Date(now.getTime() + (cfg.SHUTDOWN_GRACE_SECONDS + 1) * 1000);
		await reconcile(tdb.db, fake, cfg, later, later);

		expect((await getWorkspace(forever.id)).state).toBe("running");
		expect((await getWorkspace(mortal.id)).state).toBe("stopped");
	},
);

test.skipIf(skip)("an override of 30 applies even when the global is 0", async () => {
	await setGlobalGrace(0);
	const { id } = await runningWorkspace({ shutdown_grace_seconds: 30 });
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now, now);
	expect((await getWorkspace(id)).shutdown_deadline).not.toBeNull();

	const later = new Date(now.getTime() + 31_000);
	await reconcile(tdb.db, fake, cfg, later, later);

	expect((await getWorkspace(id)).state).toBe("stopped");
});

test.skipIf(skip)("clearing an override falls back to the global", async () => {
	const { id, ownerId } = await runningWorkspace({ shutdown_grace_seconds: 30 });
	const now = new Date();
	await reconcile(tdb.db, fake, cfg, now, now);
	const withOverride = deadlineMs((await getWorkspace(id)).shutdown_deadline);

	await tdb.db
		.updateTable("users")
		.set({ shutdown_grace_seconds: null })
		.where("id", "=", ownerId)
		.execute();
	await reconcile(tdb.db, fake, cfg, new Date(now.getTime() + 1000), now);

	const after = deadlineMs((await getWorkspace(id)).shutdown_deadline);
	expect(after - withOverride).toBe((cfg.SHUTDOWN_GRACE_SECONDS - 30) * 1000);
});

test.skipIf(skip)("without a settings row the config value is used", async () => {
	await tdb.db.deleteFrom("settings").execute();
	const { id } = await runningWorkspace();
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now, now);

	const ws = await getWorkspace(id);
	const expected = now.getTime() + cfg.SHUTDOWN_GRACE_SECONDS * 1000;
	expect(Math.abs(deadlineMs(ws.shutdown_deadline) - expected)).toBeLessThan(2000);
});

test.skipIf(skip)(
	"restarting a failed workspace clears the stale disconnect timers",
	async () => {
		const now = new Date();
		const id = await insertWorkspace({
			state: "error",
			desired_state: "running",
			disconnected_at: new Date(now.getTime() - 3600_000).toISOString(),
			shutdown_deadline: new Date(now.getTime() - 3000_000).toISOString(),
			// Past the rest period the sweep waits before retrying a start.
			updated_at: new Date(now.getTime() - 60_000).toISOString(),
		});

		await reconcile(tdb.db, fake, cfg, now, now);
		let ws = await getWorkspace(id);
		expect(ws.state).toBe("running");
		expect(ws.disconnected_at).toBeNull();
		expect(ws.shutdown_deadline).toBeNull();

		// A sweep with no connections arms a fresh deadline instead of stopping.
		const later = new Date(now.getTime() + 1000);
		await reconcile(tdb.db, fake, cfg, later, later);

		ws = await getWorkspace(id);
		expect(ws.state).toBe("running");
		expect(deadlineMs(ws.shutdown_deadline)).toBeGreaterThan(later.getTime());
	},
);

test.skipIf(skip)("the agent token never appears in audit metadata", async () => {
	const id = await insertWorkspace({ state: "stopped", desired_state: "running" });
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now, now);
	const token = (await getWorkspace(id)).agent_token as string;

	const audits = await tdb.db.selectFrom("audit_events").selectAll().execute();
	expect(audits.length).toBeGreaterThan(0);
	for (const row of audits) {
		expect(JSON.stringify(row)).not.toContain(token);
	}
});

test.skipIf(skip)(
	"each live workspace gets one debug line naming its action",
	async () => {
		const { logger: log, lines } = collectingLogger("debug");

		const starting = await insertWorkspace({
			incus_instance_name: "ws-log-a",
			state: "stopped",
			desired_state: "running",
		});
		const idle = await insertWorkspace({
			incus_instance_name: "ws-log-b",
			state: "stopped",
			desired_state: "stopped",
		});
		// Both instances exist, so drift handling leaves them alone.
		fake.listResult = [
			{ name: "ws-log-a", status: "Running", ipv4: "10.0.0.2" },
			{ name: "ws-log-b", status: "Stopped", ipv4: "10.0.0.3" },
		];

		await reconcile(tdb.db, fake, cfg, new Date(), null, false, log);

		const decisions = lines.filter((line) => line.msg === "workspace decision");
		expect(decisions.length).toBe(2);
		const byId = new Map(decisions.map((line) => [line.workspaceId, line]));
		expect(byId.get(starting)?.action).toBe("start");
		expect(byId.get(starting)?.state).toBe("stopped");
		expect(byId.get(starting)?.desiredState).toBe("running");
		expect(byId.get(idle)?.action).toBe("none");
		expect(byId.get(idle)).toHaveProperty("shutdownDeadline");
		expect(byId.get(idle)).toHaveProperty("disconnectedAt");
	},
);

/**
 * Counts the debug snapshot query: the only select over every workspace row
 * with no where clause.
 */
class SnapshotCounter implements KyselyPlugin {
	count = 0;
	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		const node = args.node as RootOperationNode & {
			where?: unknown;
			selections?: unknown;
		};
		if (
			node.kind === "SelectQueryNode" &&
			!node.where &&
			JSON.stringify(node.selections ?? "").includes("disconnected_at")
		) {
			this.count++;
		}
		return args.node;
	}
	async transformResult(args: { result: unknown }): Promise<never> {
		return args.result as never;
	}
}

test.skipIf(skip)("the debug snapshot query is not issued at info", async () => {
	await insertWorkspace({
		incus_instance_name: "ws-log-c",
		state: "stopped",
		desired_state: "stopped",
	});
	fake.listResult = [{ name: "ws-log-c", status: "Stopped", ipv4: "10.0.0.4" }];

	const counter = new SnapshotCounter();
	const db = tdb.db.withPlugin(counter);

	const { logger: quiet } = collectingLogger("info");
	await reconcile(db, fake, cfg, new Date(), null, false, quiet);
	expect(counter.count).toBe(0);

	const { logger: loud } = collectingLogger("debug");
	await reconcile(db, fake, cfg, new Date(), null, false, loud);
	expect(counter.count).toBe(1);
});

// --- Maintenance operations (SPEC.md §16.4, §17.2, §22.3; ADR 0021) ---

beforeEach(() => {
	fake.resetDockerResult = null;
	fake.rebuildResult = { imageFingerprint: "rebuilt456" };
});

/** A workspace row with a pending operation asked for by a real user. */
async function insertPending(
	operation: string,
	overrides: Record<string, unknown> = {},
): Promise<string> {
	const by = await insertTestUser(tdb.db);
	return insertWorkspace({
		pending_operation: operation,
		pending_operation_at: new Date(Date.now() - 1000).toISOString(),
		pending_operation_by: by,
		...overrides,
	});
}

function methods(): string[] {
	return fake.calls.map((c) => c.method);
}

test.skipIf(skip)(
	"reset docker on a running workspace: stop, reset, then restart",
	async () => {
		const id = await insertPending("reset-docker", {
			state: "running",
			desired_state: "running",
		});
		await insertConnection(id);
		const now = new Date();

		await reconcile(tdb.db, fake, cfg, now, now);

		expect(methods()).toEqual(["stop", "resetDocker"]);
		expect(fake.calls[1]?.args[1]).toEqual({
			dockerGiB: cfg.WORKSPACE_DOCKER_SIZE_GIB,
		});
		let ws = await getWorkspace(id);
		expect(ws.state).toBe("stopped");
		expect(ws.desired_state).toBe("running");
		expect(ws.pending_operation).toBeNull();
		expect(ws.pending_operation_at).toBeNull();
		const audit = (await getAudits(id)).find(
			(a) => a.action === "workspace.docker_reset",
		);
		expect(audit?.result).toBe("ok");

		await reconcile(tdb.db, fake, cfg, new Date(), now);
		ws = await getWorkspace(id);
		expect(ws.state).toBe("running");
		expect(methods()).toEqual(["stop", "resetDocker", "start"]);
	},
);

test.skipIf(skip)("no start while an operation is pending", async () => {
	const id = await insertPending("reset-docker", { desired_state: "running" });
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now, now);

	// The start step runs before the operation step, so a start here would
	// have come first.
	expect(methods()).toEqual(["resetDocker"]);
	expect((await getWorkspace(id)).state).toBe("stopped");
});

test.skipIf(skip)("a workspace that should stay stopped stays stopped", async () => {
	const id = await insertPending("reset-docker");
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now, now);
	await reconcile(tdb.db, fake, cfg, new Date(), now);

	expect(methods()).toEqual(["resetDocker"]);
	expect((await getWorkspace(id)).state).toBe("stopped");
});

test.skipIf(skip)(
	"an errored workspace runs its pending rebuild, not a start retry",
	async () => {
		const id = await insertPending("rebuild", {
			state: "error",
			desired_state: "running",
			error_code: "OPERATION_FAILED",
			error_message: "broken",
			updated_at: new Date(Date.now() - 60_000).toISOString(),
		});
		const now = new Date();

		await reconcile(tdb.db, fake, cfg, now, now);

		expect(methods()).toEqual(["rebuild"]);
		expect(fake.calls[0]?.args[1]).toEqual({
			resetDocker: false,
			dockerGiB: cfg.WORKSPACE_DOCKER_SIZE_GIB,
		});
		const ws = await getWorkspace(id);
		expect(ws.state).toBe("stopped");
		expect(ws.error_code).toBeNull();
		expect(ws.error_message).toBeNull();
		expect(ws.image_version).toBe("rebuilt456");
		expect(ws.pending_operation).toBeNull();
		const audit = (await getAudits(id)).find((a) => a.action === "workspace.rebuilt");
		expect(audit?.result).toBe("ok");
		expect(audit?.metadata).toMatchObject({
			operation: "rebuild",
			imageFingerprint: "rebuilt456",
		});

		await reconcile(tdb.db, fake, cfg, new Date(), now);
		expect((await getWorkspace(id)).state).toBe("running");
	},
);

test.skipIf(skip)(
	"rebuild with reset docker asks the controller for both",
	async () => {
		await insertPending("rebuild-reset-docker");
		const now = new Date();

		await reconcile(tdb.db, fake, cfg, now, now);

		expect(fake.calls[0]).toEqual({
			method: "rebuild",
			args: [
				expect.any(String),
				{ resetDocker: true, dockerGiB: cfg.WORKSPACE_DOCKER_SIZE_GIB },
			],
		});
	},
);

test.skipIf(skip)(
	"a failed rebuild leaves error, a message, and an audit row",
	async () => {
		fake.rebuildResult = FakeControllerClient.error(
			"OPERATION_FAILED",
			"incus said no",
		);
		const id = await insertPending("rebuild", { desired_state: "running" });
		const now = new Date();

		await reconcile(tdb.db, fake, cfg, now, now);

		const ws = await getWorkspace(id);
		expect(ws.state).toBe("error");
		expect(ws.error_code).toBe("OPERATION_FAILED");
		expect(ws.error_message).toMatch(/could not be rebuilt/);
		expect(ws.pending_operation).toBeNull();
		const audit = (await getAudits(id)).find(
			(a) => a.action === "workspace.rebuild_failed",
		);
		expect(audit?.result).toBe("failed");
		expect(audit?.metadata).toMatchObject({ errorCode: "OPERATION_FAILED" });
	},
);

test.skipIf(skip)("a failed docker reset is audited as such", async () => {
	fake.resetDockerResult = FakeControllerClient.error("TIMEOUT");
	const id = await insertPending("reset-docker");
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now, now);

	const ws = await getWorkspace(id);
	expect(ws.state).toBe("error");
	expect(ws.error_message).toMatch(/Docker could not be reset/);
	const actions = (await getAudits(id)).map((a) => a.action);
	expect(actions).toContain("workspace.docker_reset_failed");
});

test.skipIf(skip)(
	"a running rebuild waits until each active project was tried for a point",
	async () => {
		const id = await insertPending("rebuild", {
			state: "running",
			desired_state: "running",
		});
		await insertConnection(id);
		const project = await tdb.db
			.insertInto("projects")
			.values({
				workspace_id: id,
				slug: "demo",
				name: "demo",
				path: "/home/student/projects/demo",
				source: "new",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const now = new Date();

		await reconcile(tdb.db, fake, cfg, now, now);
		expect(methods()).toEqual([]);
		expect((await getWorkspace(id)).state).toBe("running");

		// The recovery loop stamps the project once it has tried.
		await tdb.db
			.updateTable("projects")
			.set({ recovery_checked_at: new Date().toISOString() })
			.where("id", "=", project.id)
			.execute();

		await reconcile(tdb.db, fake, cfg, new Date(), now);
		expect(methods()).toEqual(["stop", "rebuild"]);
		const ws = await getWorkspace(id);
		expect(ws.state).toBe("stopped");
		expect(ws.desired_state).toBe("running");
	},
);

test.skipIf(skip)("create and start send the recovery volume size", async () => {
	const id = await insertWorkspace({ state: "provisioning", desired_state: "running" });
	const now = new Date();

	await reconcile(tdb.db, fake, cfg, now, now);
	await reconcile(tdb.db, fake, cfg, new Date(), now);

	const create = fake.calls.find((c) => c.method === "create");
	expect(create?.args[0]).toMatchObject({ recoveryGiB: 3 });
	const start = fake.calls.find((c) => c.method === "start");
	expect(start?.args[1]).toMatchObject({ recoveryGiB: 3 });
	const ws = await getWorkspace(id);
	expect(ws.quota_config).toEqual({ homeGiB: 25, dockerGiB: 20, recoveryGiB: 3 });
});

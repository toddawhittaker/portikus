/**
 * The worker's side of the administrator's process list (ADR 0037;
 * docs/EPIC-21.md ruling 16): each pending Refresh is served once, from the
 * controller, and old snapshots are deleted.
 */
import type { InstanceProcess } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ControllerClientError } from "./controller-client.js";
import { FakeControllerClient } from "./fake-controller.js";
import {
	PROCESS_SNAPSHOT_MAX_AGE_MS,
	serveProcessSnapshots,
	startProcessSnapshots,
} from "./process-snapshots.js";

const skip = !hasTestDb();
let tdb: TestDb;
let controller: FakeControllerClient;

const ROW: InstanceProcess = {
	pid: 4242,
	uid: 1000,
	name: "zzminer",
	startTicks: 5,
	cpuPercent: 99,
	residentBytes: 1024,
	protected: false,
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
	controller = new FakeControllerClient();
	controller.processesResult = [ROW];
});

async function workspace(state = "running"): Promise<string> {
	const row = await tdb.db
		.insertInto("workspaces")
		.values({
			label: `ws${Math.random().toString(36).slice(2, 8)}`,
			owner_user_id: await insertTestUser(tdb.db),
			incus_instance_name: `ws-${Math.random().toString(36).slice(2, 8)}`,
			state,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

async function request(id: string, at = new Date()): Promise<void> {
	await tdb.db
		.insertInto("workspace_process_snapshots")
		.values({ workspace_id: id, requested_at: at.toISOString() })
		.onConflict((oc) =>
			oc.column("workspace_id").doUpdateSet({ requested_at: at.toISOString() }),
		)
		.execute();
}

async function snapshot(id: string) {
	return tdb.db
		.selectFrom("workspace_process_snapshots")
		.selectAll()
		.where("workspace_id", "=", id)
		.executeTakeFirst();
}

test.skipIf(skip)("serves a pending request once and records the rows", async () => {
	const id = await workspace();
	await request(id);
	const { logger, lines } = collectingLogger("debug");
	expect(await serveProcessSnapshots(tdb.db, controller, logger)).toBe(1);
	const row = await snapshot(id);
	expect(row?.taken_at).not.toBeNull();
	expect(row?.processes).toEqual([ROW]);
	expect(row?.error).toBeNull();
	expect(await serveProcessSnapshots(tdb.db, controller, logger)).toBe(0);
	expect(controller.calls.filter((c) => c.method === "processes")).toHaveLength(1);
	expect(JSON.stringify(lines)).not.toContain("zzminer");
});

test.skipIf(skip)("serves a request stored with microseconds", async () => {
	const id = await workspace();
	await sql`insert into workspace_process_snapshots (workspace_id, requested_at)
		values (${id}, '2026-09-26T10:00:00.123456Z')`.execute(tdb.db);
	const { logger } = collectingLogger("debug");
	await serveProcessSnapshots(
		tdb.db,
		controller,
		logger,
		() => new Date("2026-09-26T10:00:01Z"),
	);
	expect(
		await serveProcessSnapshots(
			tdb.db,
			controller,
			logger,
			() => new Date("2026-09-26T10:00:02Z"),
		),
	).toBe(0);
});

test.skipIf(skip)("a new Refresh is served again", async () => {
	const id = await workspace();
	const { logger } = collectingLogger("debug");
	await request(id, new Date(Date.now() - 5000));
	await serveProcessSnapshots(tdb.db, controller, logger);
	await request(id);
	expect(await serveProcessSnapshots(tdb.db, controller, logger)).toBe(1);
});

test.skipIf(skip)(
	"a stopped workspace gets WORKSPACE_NOT_RUNNING without a controller call",
	async () => {
		const id = await workspace("stopped");
		await request(id);
		const { logger } = collectingLogger("debug");
		await serveProcessSnapshots(tdb.db, controller, logger);
		const row = await snapshot(id);
		expect(row?.error).toBe("WORKSPACE_NOT_RUNNING");
		expect(row?.taken_at).not.toBeNull();
		expect(controller.calls).toEqual([]);
	},
);

test.skipIf(skip)("a controller error is recorded by code", async () => {
	const id = await workspace();
	await request(id);
	controller.processesResult = new ControllerClientError("TIMEOUT", "slow");
	const { logger } = collectingLogger("debug");
	await serveProcessSnapshots(tdb.db, controller, logger);
	const row = await snapshot(id);
	expect(row?.error).toBe("TIMEOUT");
	expect(row?.processes).toBeNull();
});

test.skipIf(skip)("the controller call carries a timeout signal", async () => {
	const id = await workspace();
	await request(id);
	const { logger } = collectingLogger("debug");
	await serveProcessSnapshots(tdb.db, controller, logger);
	const call = controller.calls.find((c) => c.method === "processes");
	expect(call?.args[1]).toBeInstanceOf(AbortSignal);
});

test.skipIf(skip)("rows older than an hour are deleted", async () => {
	const old = await workspace();
	const fresh = await workspace();
	const now = new Date();
	await request(old, new Date(now.getTime() - PROCESS_SNAPSHOT_MAX_AGE_MS - 1000));
	await request(fresh, now);
	const { logger } = collectingLogger("debug");
	await serveProcessSnapshots(tdb.db, controller, logger, () => now);
	expect(await snapshot(old)).toBeUndefined();
	expect(await snapshot(fresh)).toBeDefined();
});

test.skipIf(skip)("the loop serves a request and stops cleanly", async () => {
	const id = await workspace();
	await request(id);
	const { logger } = collectingLogger("debug");
	const stop = startProcessSnapshots({ db: tdb.db, controller, logger });
	await expect
		.poll(async () => (await snapshot(id))?.taken_at ?? null, { timeout: 5000 })
		.not.toBeNull();
	stop();
});

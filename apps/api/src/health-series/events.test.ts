import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eventSeries } from "./events.js";
import { seriesWindow } from "./range.js";

const skip = !hasTestDb();
const NOW = new Date("2026-09-26T14:07:30.000Z");
let testDb: TestDb;

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
	await testDb.db.deleteFrom("audit_events").execute();
});

async function audit(action: string, at: string, result = "ok"): Promise<void> {
	await testDb.db
		.insertInto("audit_events")
		.values({
			actor: "worker",
			target: "t",
			action,
			result,
			metadata: null,
			at,
		} as never)
		.execute();
}

test.skipIf(skip)("counts each action per bucket as the charts name them", async () => {
	await audit("workspace.cpu_throttled", "2026-09-26T14:01:00Z");
	await audit("workspace.cpu_throttled", "2026-09-26T14:04:00Z");
	await audit("workspace.memory_flagged", "2026-09-26T14:02:00Z");
	await audit("workspace.idle_stopped", "2026-09-26T14:03:00Z");
	await audit("workspace.cpu_throttle_lifted", "2026-09-26T14:03:00Z");
	await audit("workspace.memory_flag_cleared", "2026-09-26T14:03:30Z");
	await audit("workspace.start_requested", "2026-09-26T14:00:10Z");
	await audit("workspace.stop_requested", "2026-09-26T14:04:59Z");
	await audit("auth.login", "2026-09-26T14:01:00Z");
	await audit("auth.login", "2026-09-26T14:01:00Z", "failed");
	await audit("auth.login", "2026-09-26T14:01:00Z", "denied");
	// Not counted: another action, and one before the range.
	await audit("workspace.stopped", "2026-09-26T14:02:00Z");
	await audit("workspace.start_requested", "2026-09-26T08:00:00Z");
	// The next five-minute bucket.
	await audit("workspace.start_requested", "2026-09-26T14:05:00Z");

	const points = await eventSeries(testDb.db, seriesWindow("6h", NOW));

	expect(points).toEqual([
		{
			at: "2026-09-26T14:00:00.000Z",
			throttles: 2,
			memoryFlags: 1,
			idleStops: 1,
			guardLifts: 2,
			starts: 1,
			// An idle stop is a stop too.
			stops: 2,
			signIns: 1,
		},
		{
			at: "2026-09-26T14:05:00.000Z",
			throttles: 0,
			memoryFlags: 0,
			idleStops: 0,
			guardLifts: 0,
			starts: 1,
			stops: 0,
			signIns: 0,
		},
	]);
});

test.skipIf(skip)("a bucket with only failed sign-ins is left out", async () => {
	await audit("auth.login", "2026-09-26T14:01:00Z", "failed");

	expect(await eventSeries(testDb.db, seriesWindow("1h", NOW))).toEqual([]);
});

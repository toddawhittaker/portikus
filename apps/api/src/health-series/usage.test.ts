import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { seriesWindow } from "./range.js";
import { pairCpuPercent, USAGE_MAX_ROWS, usageFrom, usageSeries } from "./usage.js";

const skip = !hasTestDb();
const NOW = new Date("2026-09-26T14:07:30.000Z");
const GiB = 1024 ** 3;
let testDb: TestDb;

function sample(
	at: string,
	cpuSeconds: number,
	memoryGiB = 1,
	bootMarker: number | null = 7,
) {
	return {
		observedAt: new Date(at),
		cpuUsageNs: BigInt(cpuSeconds * 1e9),
		bootMarker: bootMarker === null ? null : String(bootMarker),
		cpuLimit: 2,
		memoryBytes: memoryGiB * GiB,
		memoryLimitBytes: 4 * GiB,
	};
}

describe("pairCpuPercent", () => {
	test("is the CPU time over the limit's allowance, as the guard computes it", () => {
		// 60 s of CPU in 60 s on 2 CPUs is half the allowance.
		expect(
			pairCpuPercent(
				sample("2026-09-26T14:00:00Z", 100),
				sample("2026-09-26T14:01:00Z", 160),
			),
		).toBe(50);
	});

	test("across a restart counts the new counter plus one interval of full use", () => {
		// Counter dropped: 12 s used since boot plus 60 s at 2 CPUs, over 60 s at 2 CPUs.
		expect(
			pairCpuPercent(
				sample("2026-09-26T14:00:00Z", 500),
				sample("2026-09-26T14:01:00Z", 12),
			),
		).toBeCloseTo(110);
		// Boot marker changed with a higher counter.
		expect(
			pairCpuPercent(
				sample("2026-09-26T14:00:00Z", 10, 1, 7),
				sample("2026-09-26T14:01:00Z", 12, 1, 8),
			),
		).toBeCloseTo(110);
	});

	test("no elapsed time has no value", () => {
		expect(
			pairCpuPercent(
				sample("2026-09-26T14:00:00Z", 1),
				sample("2026-09-26T14:00:00Z", 2),
			),
		).toBeNull();
	});
});

describe("usageFrom", () => {
	test("is the range's start when the range fits in the retention", () => {
		const window = seriesWindow("1h", NOW);
		expect(usageFrom(window)).toEqual(window.from);
	});

	test("is limited to about 245 minutes, on a bucket edge, for longer ranges", () => {
		// 1 day, 15-minute buckets: to is 14:15, 245 minutes before is 10:10,
		// so the bucket holding it starts at 10:00.
		expect(usageFrom(seriesWindow("1d", NOW)).toISOString()).toBe(
			"2026-09-26T10:00:00.000Z",
		);
		expect(usageFrom(seriesWindow("7d", NOW)).toISOString()).toBe(
			"2026-09-26T10:00:00.000Z",
		);
	});
});

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
	await testDb.db.deleteFrom("workspace_usage_samples").execute();
	await testDb.db.deleteFrom("workspaces").execute();
	await testDb.db
		.insertInto("settings")
		.values({ id: 1, shutdown_grace_seconds: 900 })
		.onConflict((oc) => oc.doNothing())
		.execute();
});

async function workspace(
	name: string,
	guardConfig: Record<string, number> | null = null,
): Promise<{ id: string; ownerId: string }> {
	const user = await testDb.db
		.insertInto("users")
		.values({
			oidc_issuer: "http://mock",
			oidc_subject: `subject-${crypto.randomUUID()}`,
			display_name: name,
			email: null,
			role: "student",
			shutdown_grace_seconds: null,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	const ws = await testDb.db
		.insertInto("workspaces")
		.values({
			owner_user_id: user.id,
			label: name.toLowerCase(),
			state: "running",
			incus_instance_name: `ws-${crypto.randomUUID().slice(0, 8)}`,
			guard_config: guardConfig === null ? null : JSON.stringify(guardConfig),
		} as never)
		.returning("id")
		.executeTakeFirstOrThrow();
	return { id: ws.id, ownerId: user.id };
}

async function usage(
	id: string,
	at: string,
	cpuSeconds: number,
	memoryGiB: number,
): Promise<void> {
	await testDb.db
		.insertInto("workspace_usage_samples")
		.values({
			workspace_id: id,
			observed_at: at,
			cpu_usage_ns: cpuSeconds * 1e9,
			boot_marker: 7,
			cpu_limit: 2,
			memory_bytes: memoryGiB * GiB,
			memory_limit_bytes: 4 * GiB,
		})
		.execute();
}

test.skipIf(skip)(
	"cells hold the highest CPU and memory per bucket, with each workspace's thresholds",
	async () => {
		const ann = await workspace("Ann", { cpuThresholdPercent: 60 });
		const bob = await workspace("Bob");
		// Ann: 30 s, then 90 s of CPU per minute on 2 CPUs (25%, 75%).
		await usage(ann.id, "2026-09-26T14:00:00Z", 0, 1);
		await usage(ann.id, "2026-09-26T14:01:00Z", 30, 2);
		await usage(ann.id, "2026-09-26T14:02:00Z", 120, 1);
		await usage(ann.id, "2026-09-26T14:06:00Z", 120, 3);
		await usage(bob.id, "2026-09-26T14:06:00Z", 5, 4);

		const body = await usageSeries(testDb.db, seriesWindow("6h", NOW));

		expect(body.retentionMinutes).toBe(245);
		expect(body.workspaces).toEqual([
			{
				workspaceId: ann.id,
				owner: { id: ann.ownerId, displayName: "Ann" },
				cpuThresholdPercent: 60,
				memoryThresholdPercent: 90,
				cells: [
					{ at: "2026-09-26T14:00:00.000Z", cpuPercent: 75, memoryPercent: 50 },
					// No CPU used over the four minutes.
					{ at: "2026-09-26T14:05:00.000Z", cpuPercent: 0, memoryPercent: 75 },
				],
			},
			{
				workspaceId: bob.id,
				owner: { id: bob.ownerId, displayName: "Bob" },
				cpuThresholdPercent: 80,
				memoryThresholdPercent: 90,
				// One sample has no CPU delta yet.
				cells: [
					{ at: "2026-09-26T14:05:00.000Z", cpuPercent: null, memoryPercent: 100 },
				],
			},
		]);
	},
);

test.skipIf(skip)("samples older than the retention window are not shown", async () => {
	const ann = await workspace("Ann");
	await usage(ann.id, "2026-09-26T09:00:00Z", 0, 1);
	await usage(ann.id, "2026-09-26T09:59:00Z", 0, 1);
	await usage(ann.id, "2026-09-26T14:00:00Z", 0, 1);

	const body = await usageSeries(testDb.db, seriesWindow("1d", NOW));

	expect(body.from).toBe("2026-09-26T10:00:00.000Z");
	expect(body.workspaces[0]?.cells.map((cell) => cell.at)).toEqual([
		"2026-09-26T14:00:00.000Z",
	]);
});

test.skipIf(skip)("keeps the 50 highest peaks, sorted by owner name", async () => {
	const ids: string[] = [];
	for (let i = 0; i < USAGE_MAX_ROWS + 2; i++) {
		// Names run backwards so the owner sort is visible; memory rises with i.
		const ws = await workspace(`User ${String(99 - i).padStart(2, "0")}`);
		ids.push(ws.id);
		await usage(ws.id, "2026-09-26T14:00:00Z", 0, (i + 1) / 16);
	}

	const body = await usageSeries(testDb.db, seriesWindow("1h", NOW));

	expect(body.workspaces).toHaveLength(USAGE_MAX_ROWS);
	// The two lowest peaks (i = 0 and 1) are dropped.
	expect(body.workspaces.map((row) => row.workspaceId)).not.toContain(ids[0]);
	expect(body.workspaces.map((row) => row.workspaceId)).not.toContain(ids[1]);
	const names = body.workspaces.map((row) => row.owner.displayName);
	expect(names).toEqual([...names].sort());
});

test.skipIf(skip)("no samples gives no rows", async () => {
	const body = await usageSeries(testDb.db, seriesWindow("1h", NOW));
	expect(body.workspaces).toEqual([]);
});

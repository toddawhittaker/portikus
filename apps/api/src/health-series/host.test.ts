import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { hostSeries, newestCpuCount } from "./host.js";
import { seriesWindow } from "./range.js";

const skip = !hasTestDb();
const GiB = 1024 ** 3;
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
	await testDb.db.deleteFrom("health_samples").execute();
});

function host(poolUsedGiB: number, load: [number, number, number], cpuCount = 4) {
	return {
		observedAt: NOW.toISOString(),
		loadAverage: load,
		cpuCount,
		memory: { usedBytes: 8 * GiB, totalBytes: 32 * GiB },
		pool: { name: "portikus", usedBytes: poolUsedGiB * GiB, totalBytes: 200 * GiB },
		profileLimits: { cpu: null, memory: null, processes: null },
		image: { fingerprint: null, serial: null },
		instances: [],
	};
}

async function seed(at: string, value: unknown): Promise<void> {
	await testDb.db
		.insertInto("health_samples")
		.values({ observed_at: at, sample: JSON.stringify(value) } as never)
		.execute();
}

const reachable = { reachable: true, errorCode: null };

test.skipIf(skip)("each bucket holds the maxima of its samples", async () => {
	await seed("2026-09-26T14:01:10Z", {
		controller: reachable,
		host: host(20, [1, 3, 1]),
	});
	await seed("2026-09-26T14:04:50Z", {
		controller: reachable,
		host: host(50, [2, 1, 4]),
	});
	// The next five-minute bucket.
	await seed("2026-09-26T14:06:00Z", {
		controller: reachable,
		host: host(10, [0, 0, 0]),
	});

	const points = await hostSeries(testDb.db, seriesWindow("6h", NOW));

	expect(points).toEqual([
		{
			at: "2026-09-26T14:00:00.000Z",
			poolPercent: 25,
			memoryPercent: 25,
			load1: 2,
			load5: 3,
			load15: 4,
		},
		{
			at: "2026-09-26T14:05:00.000Z",
			poolPercent: 5,
			memoryPercent: 25,
			load1: 0,
			load5: 0,
			load15: 0,
		},
	]);
});

test.skipIf(skip)("samples without host figures leave a gap", async () => {
	await seed("2026-09-26T13:50:00Z", {
		controller: reachable,
		host: host(20, [1, 1, 1]),
	});
	await seed("2026-09-26T14:00:00Z", {
		controller: { reachable: false, errorCode: "CONTROLLER_UNREACHABLE" },
		host: null,
	});

	const points = await hostSeries(testDb.db, seriesWindow("1h", NOW));

	expect(points.map((point) => point.at)).toEqual(["2026-09-26T13:50:00.000Z"]);
});

test.skipIf(skip)("samples outside the window are left out", async () => {
	await seed("2026-09-26T12:00:00Z", {
		controller: reachable,
		host: host(20, [1, 1, 1]),
	});
	expect(await hostSeries(testDb.db, seriesWindow("1h", NOW))).toEqual([]);
});

test.skipIf(skip)(
	"the CPU count comes from the newest sample with a host",
	async () => {
		expect(await newestCpuCount(testDb.db)).toBeNull();
		await seed("2026-09-26T13:00:00Z", {
			controller: reachable,
			host: host(1, [0, 0, 0], 2),
		});
		await seed("2026-09-26T13:30:00Z", {
			controller: reachable,
			host: host(1, [0, 0, 0], 6),
		});
		await seed("2026-09-26T14:00:00Z", { controller: reachable, host: null });
		expect(await newestCpuCount(testDb.db)).toBe(6);
	},
);

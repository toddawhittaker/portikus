import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { platformSeries } from "./platform.js";
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
	await testDb.db.deleteFrom("health_samples").execute();
});

function up(cpuPercent: number, rx: number, running: number) {
	return {
		controller: { reachable: true, errorCode: null },
		host: {
			observedAt: NOW.toISOString(),
			loadAverage: [0, 0, 0],
			cpuCount: 4,
			memory: { usedBytes: 1, totalBytes: 2 },
			pool: { name: "portikus", usedBytes: 1, totalBytes: 2 },
			profileLimits: { cpu: null, memory: null, processes: null },
			image: { fingerprint: null, serial: null },
			instances: [],
			rates: {
				cpuPercent,
				netRxBytesPerSecond: rx,
				netTxBytesPerSecond: rx / 2,
				diskReadBytesPerSecond: 0,
				diskWriteBytesPerSecond: 512,
			},
		},
		runningWorkspaces: running,
	};
}

const down = {
	controller: { reachable: false, errorCode: "CONTROLLER_UNAVAILABLE" },
	host: null,
	runningWorkspaces: 1,
};

async function seed(at: string, value: unknown): Promise<void> {
	await testDb.db
		.insertInto("health_samples")
		.values({ observed_at: at, sample: JSON.stringify(value) } as never)
		.execute();
}

test.skipIf(skip)(
	"buckets hold maxima for CPU and running, averages for throughput, and minute counts",
	async () => {
		await seed("2026-09-26T14:00:10Z", up(20, 1000, 2));
		await seed("2026-09-26T14:01:10Z", up(60, 3000, 3));
		await seed("2026-09-26T14:02:10Z", down);
		// A second sample in the same minute counts that minute once.
		await seed("2026-09-26T14:02:40Z", down);
		// 14:03 and 14:04 have no samples; 14:05 to 14:09 is the next bucket.
		await seed("2026-09-26T14:06:00Z", up(5, 0, 0));

		const points = await platformSeries(testDb.db, seriesWindow("6h", NOW));

		expect(points).toEqual([
			{
				at: "2026-09-26T14:00:00.000Z",
				sampleMinutes: 3,
				reachableMinutes: 2,
				runningWorkspaces: 3,
				cpuPercent: 60,
				netRxBytesPerSecond: 2000,
				netTxBytesPerSecond: 1000,
				diskReadBytesPerSecond: 0,
				diskWriteBytesPerSecond: 512,
			},
			{
				at: "2026-09-26T14:05:00.000Z",
				sampleMinutes: 1,
				reachableMinutes: 1,
				runningWorkspaces: 0,
				cpuPercent: 5,
				netRxBytesPerSecond: 0,
				netTxBytesPerSecond: 0,
				diskReadBytesPerSecond: 0,
				diskWriteBytesPerSecond: 512,
			},
		]);
	},
);

test.skipIf(skip)(
	"a bucket with no samples is absent, and old samples give null figures",
	async () => {
		const old = up(0, 0, 0);
		const { rates: _rates, ...oldHost } = old.host;
		await seed("2026-09-26T13:40:00Z", { controller: old.controller, host: oldHost });

		const points = await platformSeries(testDb.db, seriesWindow("1h", NOW));

		expect(points).toEqual([
			{
				at: "2026-09-26T13:40:00.000Z",
				sampleMinutes: 1,
				reachableMinutes: 1,
				runningWorkspaces: null,
				cpuPercent: null,
				netRxBytesPerSecond: null,
				netTxBytesPerSecond: null,
				diskReadBytesPerSecond: null,
				diskWriteBytesPerSecond: null,
			},
		]);
	},
);

test.skipIf(skip)("samples outside the window are left out", async () => {
	await seed("2026-09-26T13:00:00Z", up(50, 0, 1));
	expect(await platformSeries(testDb.db, seriesWindow("1h", NOW))).toEqual([]);
});

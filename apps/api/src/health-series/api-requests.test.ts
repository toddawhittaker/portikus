import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { API_LATENCY_BOUNDS_MS } from "../request-metrics.js";
import { apiRequestSeries, latencyPercentile } from "./api-requests.js";
import { seriesWindow } from "./range.js";

const EMPTY = new Array(API_LATENCY_BOUNDS_MS.length + 1).fill(0) as number[];

function histogram(counts: Record<number, number>): number[] {
	return EMPTY.map((_, index) => counts[index] ?? 0);
}

describe("latencyPercentile", () => {
	test("is null with no requests", () => {
		expect(latencyPercentile(EMPTY, 0.5)).toBeNull();
		expect(latencyPercentile([], 0.95)).toBeNull();
	});

	test("interpolates inside the one bucket that has requests", () => {
		// Bucket 2 spans 10 to 25 ms.
		expect(latencyPercentile(histogram({ 2: 10 }), 0.5)).toBe(17.5);
		expect(latencyPercentile(histogram({ 0: 4 }), 0.5)).toBe(2.5);
	});

	test("finds the bucket holding the percentile across several", () => {
		// 50 under 5 ms, 50 in 100 to 250 ms: the median is the top of the first.
		const buckets = histogram({ 0: 50, 5: 50 });
		expect(latencyPercentile(buckets, 0.5)).toBe(5);
		// 95th: 45 of 50 into 100..250 ms.
		expect(latencyPercentile(buckets, 0.95)).toBe(235);
	});

	test("the overflow bucket reports its lower bound", () => {
		expect(
			latencyPercentile(histogram({ [API_LATENCY_BOUNDS_MS.length]: 3 }), 0.95),
		).toBe(10_000);
	});
});

describe("apiRequestSeries", () => {
	const skip = !hasTestDb();
	let t: TestDb;

	beforeAll(async () => {
		if (!skip) t = await createTestDb();
	});

	afterAll(async () => {
		await t?.close();
	});

	beforeEach(async () => {
		if (!skip) await t.db.deleteFrom("api_request_samples").execute();
	});

	async function seed(
		minute: string,
		requests: number,
		latency: number[],
		errors = [0, 0],
	) {
		await t.db
			.insertInto("api_request_samples")
			.values({
				minute: new Date(minute),
				requests,
				client_errors: errors[0] ?? 0,
				server_errors: errors[1] ?? 0,
				websocket_upgrades: 1,
				latency_buckets: latency,
			})
			.execute();
	}

	test.skipIf(skip)(
		"sums each bucket's minutes and computes percentiles from the summed histogram",
		async () => {
			// Several minutes share one bucket in the 6h range.
			const window = seriesWindow("6h", new Date("2026-09-26T14:07:30Z"));
			const inBucket = new Date(window.to.getTime() - window.bucketSeconds * 1000);
			const first = inBucket.toISOString();
			const second = new Date(inBucket.getTime() + 60_000).toISOString();
			await seed(first, 10, histogram({ 2: 10 }), [1, 0]);
			await seed(second, 10, histogram({ 5: 10 }), [2, 1]);
			// Outside the window: ignored.
			await seed(
				new Date(window.from.getTime() - 60_000).toISOString(),
				99,
				histogram({ 0: 99 }),
			);

			const series = await apiRequestSeries(t.db, window);
			expect(series).toEqual([
				{
					at: first,
					requests: 20,
					clientErrors: 3,
					serverErrors: 1,
					webSocketUpgrades: 2,
					medianMs: 25,
					p95Ms: 235,
				},
			]);
		},
	);

	test.skipIf(skip)("a range with no rows is empty", async () => {
		expect(await apiRequestSeries(t.db, seriesWindow("1h", new Date()))).toEqual([]);
	});
});

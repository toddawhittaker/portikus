import { expect, test } from "vitest";
import {
	HEALTH_BUCKET_SECONDS,
	HEALTH_RANGE_SECONDS,
	HealthRange,
	HealthSeries,
	HealthSeriesQuery,
} from "./health-series.js";

const at = "2026-09-26T12:00:00.000Z";

test("the four ranges parse and any other is refused", () => {
	for (const range of ["1h", "6h", "1d", "7d"]) {
		expect(HealthRange.parse(range)).toBe(range);
	}
	expect(HealthSeriesQuery.safeParse({ range: "2h" }).success).toBe(false);
	expect(HealthSeriesQuery.safeParse({}).success).toBe(false);
	expect(HealthSeriesQuery.safeParse({ range: "1h", extra: "x" }).success).toBe(false);
});

test("no range has more than 168 buckets", () => {
	const counts = HealthRange.options.map(
		(range) => HEALTH_RANGE_SECONDS[range] / HEALTH_BUCKET_SECONDS[range],
	);
	expect(counts).toEqual([60, 72, 96, 168]);
});

test("a full body parses and an empty one too", () => {
	const empty = {
		range: "1d",
		bucketSeconds: 900,
		from: at,
		to: at,
		cpuCount: null,
		host: [],
		platform: [],
		events: [],
		usage: { retentionMinutes: 0, from: at, workspaces: [] },
		api: [],
	};
	expect(HealthSeries.parse(empty)).toEqual(empty);
	const full = {
		...empty,
		cpuCount: 4,
		host: [
			{ at, poolPercent: 50, memoryPercent: 20, load1: 1, load5: 0.5, load15: 0.2 },
		],
		api: [
			{
				at,
				requests: 10,
				clientErrors: 1,
				serverErrors: 0,
				webSocketUpgrades: 2,
				medianMs: null,
				p95Ms: 40,
			},
		],
	};
	expect(HealthSeries.parse(full)).toEqual(full);
	expect(HealthSeries.safeParse({ ...empty, range: "2h" }).success).toBe(false);
});

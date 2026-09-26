import { expect, test } from "vitest";
import {
	bucketPhrase,
	type ChartFrame,
	dense,
	frameOf,
	lineSummary,
	niceNumber,
	timeLabel,
	timeTickIndexes,
	yTicks,
} from "./scales.js";

test("the frame counts the range's buckets", () => {
	const frame = frameOf({
		range: "7d",
		bucketSeconds: 3600,
		from: "2026-09-19T15:00:00.000Z",
		to: "2026-09-26T15:00:00.000Z",
	});
	expect(frame.count).toBe(168);
});

test("missing buckets are gaps, and points outside the frame are dropped", () => {
	const frame: ChartFrame = {
		range: "1h",
		from: Date.parse("2026-09-26T13:00:00Z"),
		bucketSeconds: 60,
		count: 4,
	};
	const values = dense(
		frame,
		[
			{ at: "2026-09-26T13:00:00.000Z", v: 1 },
			{ at: "2026-09-26T13:02:00.000Z", v: 3 },
			{ at: "2026-09-26T14:00:00.000Z", v: 9 },
		],
		(point) => point.v,
	);
	expect(values).toEqual([1, null, 3, null]);
});

test("nice numbers and load ticks round up to 1, 2, 2.5 or 5", () => {
	expect(niceNumber(0.8)).toBe(1);
	expect(niceNumber(1.375)).toBe(2);
	expect(niceNumber(2.25)).toBe(2.5);
	expect(niceNumber(30)).toBe(50);
	expect(yTicks(4)).toEqual([0, 1, 2, 3, 4]);
	expect(yTicks(5.5)).toEqual([0, 2, 4, 6]);
	expect(yTicks(9)).toEqual([0, 2.5, 5, 7.5, 10]);
	expect(yTicks(0)).toEqual([0, 0.5, 1]);
	for (const max of [0.3, 1, 3.2, 7, 12, 99, 250]) {
		const ticks = yTicks(max);
		expect(ticks.length).toBeGreaterThanOrEqual(3);
		expect(ticks.length).toBeLessThanOrEqual(5);
		expect(ticks.at(-1)).toBeGreaterThanOrEqual(max);
	}
});

test("time labels are clock times, or weekday and date at 7 days", () => {
	const at = new Date(2026, 8, 26, 14, 0).getTime();
	expect(timeLabel(at, "1d")).toMatch(/14|2/);
	expect(timeLabel(at, "1d")).toMatch(/00/);
	expect(timeLabel(at, "7d")).toMatch(/26/);
	expect(timeLabel(at, "7d")).not.toMatch(/:/);
});

test("X labels fall on whole clock steps for each range", () => {
	const hour = new Date(2026, 8, 26, 13, 0).getTime();
	expect(
		timeTickIndexes({ range: "1h", from: hour, bucketSeconds: 60, count: 60 }),
	).toEqual([0, 10, 20, 30, 40, 50]);
	const midnight = new Date(2026, 8, 19, 0, 0).getTime();
	expect(
		timeTickIndexes({ range: "7d", from: midnight, bucketSeconds: 3600, count: 168 }),
	).toEqual([0, 24, 48, 72, 96, 120, 144]);
});

test("count charts name their bucket", () => {
	expect(bucketPhrase(60)).toBe("per minute");
	expect(bucketPhrase(300)).toBe("per 5 minutes");
	expect(bucketPhrase(900)).toBe("per 15 minutes");
	expect(bucketPhrase(3600)).toBe("per hour");
});

test("the summary names the newest and highest values", () => {
	const percent = (value: number) => `${Math.round(value)}%`;
	expect(lineSummary([10, 18, null, 16, null], percent)).toBe("Now 16%, highest 18%.");
	expect(lineSummary([null, null], percent)).toBe("No samples in this range.");
});

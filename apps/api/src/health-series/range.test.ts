import { expect, test } from "vitest";
import { seriesWindow } from "./range.js";

const NOW = new Date("2026-09-26T14:07:30.000Z");

test("each range's bucket width and aligned edges", () => {
	const cases = [
		["1h", 60, "2026-09-26T13:08:00.000Z", "2026-09-26T14:08:00.000Z"],
		["6h", 300, "2026-09-26T08:10:00.000Z", "2026-09-26T14:10:00.000Z"],
		["1d", 900, "2026-09-25T14:15:00.000Z", "2026-09-26T14:15:00.000Z"],
		["7d", 3600, "2026-09-19T15:00:00.000Z", "2026-09-26T15:00:00.000Z"],
	] as const;
	for (const [range, bucketSeconds, from, to] of cases) {
		const window = seriesWindow(range, NOW);
		expect(window.bucketSeconds).toBe(bucketSeconds);
		expect(window.from.toISOString()).toBe(from);
		expect(window.to.toISOString()).toBe(to);
	}
});

test("a time on a bucket edge starts a new bucket", () => {
	const window = seriesWindow("1d", new Date("2026-09-26T14:15:00.000Z"));
	expect(window.to.toISOString()).toBe("2026-09-26T14:30:00.000Z");
});

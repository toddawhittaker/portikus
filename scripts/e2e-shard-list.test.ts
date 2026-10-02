import { describe, expect, test } from "vitest";
// @ts-expect-error The shard script is a plain .mjs script with no type declarations.
import { packShards, parseTimings } from "./e2e-shard-list.mjs";

type Shard = { files: string[]; seconds: number };
const pack = (
	files: string[],
	timings: Record<string, number>,
	total: number,
): Shard[] => packShards(files, timings, total);

const files = Array.from(
	{ length: 40 },
	(_, i) => `f${String(i).padStart(2, "0")}.spec.ts`,
);
const timings = Object.fromEntries(files.map((file, i) => [file, ((i * 37) % 23) + 1]));

describe("packShards", () => {
	test("puts every file in exactly one shard", () => {
		const assigned = pack(files, timings, 5).flatMap((shard) => shard.files);
		expect(assigned.sort()).toEqual([...files].sort());
	});

	test("gives the same plan every time, whatever the input order", () => {
		const reversed = [...files].reverse();
		expect(pack(reversed, timings, 5)).toEqual(pack(files, timings, 5));
	});

	test("counts a file without a timing as the average", () => {
		const shards = pack(["a", "b", "new"], { a: 10, b: 20 }, 3);
		expect(shards.find((s) => s.files.includes("new"))?.seconds).toBe(15);
	});

	test("balances a sample to within the longest file", () => {
		const seconds = pack(files, timings, 5).map((shard) => shard.seconds);
		expect(Math.max(...seconds) - Math.min(...seconds)).toBeLessThanOrEqual(23);
	});
});

describe("parseTimings", () => {
	test("sums durations per file and ignores setup and other lines", () => {
		const log = [
			"job\tstep\t2026Z   \u001b[32m✓\u001b[39m    1 [setup] › e2e/environment.setup.ts:12:1 › env (233ms)",
			"job\tstep\t2026Z   ✓    2 [chromium] › e2e/files.spec.ts:435:2 › tree › one (3.0s)",
			"job\tstep\t2026Z   ✓    3 [chromium] › e2e/files.spec.ts:451:2 › tree › two (500ms)",
			"job\tstep\t2026Z   Running 3 tests",
		].join("\n");
		expect(parseTimings(log)).toEqual({ "files.spec.ts": 3.5 });
	});
});

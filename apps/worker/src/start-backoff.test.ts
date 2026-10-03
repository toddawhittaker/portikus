import { expect, test } from "vitest";
import { MAX_START_RETRIES, retryWaitMs } from "./start-backoff.js";

test("the waits run 10 s, 30 s, 1 min, 2 min, 5 min", () => {
	expect([0, 1, 2, 3, 4].map(retryWaitMs)).toEqual([
		10_000, 30_000, 60_000, 120_000, 300_000,
	]);
});

test("after five retries there is no further wait", () => {
	expect(MAX_START_RETRIES).toBe(5);
	expect(retryWaitMs(5)).toBeNull();
	expect(retryWaitMs(50)).toBeNull();
});

import { expect, test } from "vitest";
import {
	clearRetries,
	MAX_WAIT_MS,
	noteRetry,
	retryDue,
	retryWaitMs,
} from "./start-backoff.js";

const at = (ms: number) => new Date(1_800_000_000_000 + ms);

test("the wait doubles from 10 seconds and stops at 30 minutes", () => {
	expect([0, 1, 2, 3].map(retryWaitMs)).toEqual([10_000, 20_000, 40_000, 80_000]);
	expect(retryWaitMs(8)).toBe(MAX_WAIT_MS);
	expect(retryWaitMs(50)).toBe(MAX_WAIT_MS);
});

test("each retry lengthens the wait before the next one", () => {
	const id = "ws-backoff-1";
	expect(retryDue(id, "running", at(0), at(10_000))).toBe(true);
	expect(noteRetry(id, "running")).toBe(1);
	// The retry failed again at 12 s; the next waits 20 s from then.
	expect(retryDue(id, "running", at(12_000), at(31_000))).toBe(false);
	expect(retryDue(id, "running", at(12_000), at(32_000))).toBe(true);
	expect(noteRetry(id, "running")).toBe(2);
	expect(retryDue(id, "running", at(40_000), at(79_000))).toBe(false);
	expect(retryDue(id, "running", at(40_000), at(80_000))).toBe(true);
	clearRetries(id);
});

test("reaching running, or a new desired state, starts the wait over", () => {
	const id = "ws-backoff-2";
	noteRetry(id, "running");
	noteRetry(id, "running");
	expect(retryDue(id, "running", at(0), at(10_000))).toBe(false);
	clearRetries(id);
	expect(retryDue(id, "running", at(0), at(10_000))).toBe(true);

	noteRetry(id, "running");
	noteRetry(id, "running");
	expect(retryDue(id, "restarting", at(0), at(10_000))).toBe(true);
	clearRetries(id);
});

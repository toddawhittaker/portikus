import { afterEach, expect, test, vi } from "vitest";
import { describeService, loopEvery } from "./index.js";

test("describes itself", () => {
	expect(describeService()).toBe("portikus worker");
});

afterEach(() => {
	vi.useRealTimers();
});

test("a slow recovery sweep does not delay the one-second reconcile loop", async () => {
	vi.useFakeTimers();
	let sweeps = 0;
	let recoveryStarted = 0;
	// A hung agent call: the recovery pass never finishes.
	loopEvery(
		() =>
			new Promise<void>(() => {
				recoveryStarted++;
			}),
		60_000,
	);
	loopEvery(async () => {
		sweeps++;
	}, 1000);

	await vi.advanceTimersByTimeAsync(10_000);

	expect(recoveryStarted).toBe(1);
	expect(sweeps).toBe(11);
});

test("a loop waits for its task to finish before scheduling the next run", async () => {
	vi.useFakeTimers();
	let runs = 0;
	loopEvery(async () => {
		runs++;
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}, 1000);

	await vi.advanceTimersByTimeAsync(12_000);

	// Runs start at 0, 6 and 12 seconds.
	expect(runs).toBe(3);
});

// Reconciler tests are in reconcile.test.ts and recovery tests in
// recovery.test.ts (real Postgres required).

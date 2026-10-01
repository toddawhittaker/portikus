import { afterEach, expect, test, vi } from "vitest";
import { startLoop } from "./loop.js";

afterEach(() => {
	vi.useRealTimers();
});

test("a slow recovery sweep does not delay the one-second reconcile loop", async () => {
	vi.useFakeTimers();
	let sweeps = 0;
	let recoveryStarted = 0;
	// A hung agent call: the recovery pass never finishes.
	startLoop(
		() =>
			new Promise<void>(() => {
				recoveryStarted++;
			}),
		60_000,
		{ afterRun: true },
	);
	startLoop(
		async () => {
			sweeps++;
		},
		1000,
		{ afterRun: true },
	);

	await vi.advanceTimersByTimeAsync(10_000);

	expect(recoveryStarted).toBe(1);
	expect(sweeps).toBe(11);
});

test("a loop waits for its task to finish before scheduling the next run", async () => {
	vi.useFakeTimers();
	let runs = 0;
	startLoop(
		async () => {
			runs++;
			await new Promise((resolve) => setTimeout(resolve, 5000));
		},
		1000,
		{ afterRun: true },
	);

	await vi.advanceTimersByTimeAsync(12_000);

	// Runs start at 0, 6 and 12 seconds.
	expect(runs).toBe(3);
});

test("an interval loop runs now, then every interval, until stopped", async () => {
	vi.useFakeTimers();
	let runs = 0;
	const stop = startLoop(async () => {
		runs++;
	}, 1000);
	expect(runs).toBe(1);
	await vi.advanceTimersByTimeAsync(3000);
	expect(runs).toBe(4);
	stop();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(runs).toBe(4);
});

import { collectingLogger } from "@portikus/observability/testing";
import { afterEach, expect, test, vi } from "vitest";
import { startLoop, startSweepLoop } from "./loop.js";

afterEach(() => {
	vi.useRealTimers();
});

test("a slow recovery sweep does not delay the one-second reconcile loop", async () => {
	vi.useFakeTimers();
	let sweeps = 0;
	let recoveryStarted = 0;
	// A hung agent call: the recovery pass never finishes.
	startSweepLoop(
		() =>
			new Promise<void>(() => {
				recoveryStarted++;
			}),
		60_000,
	);
	startSweepLoop(async () => {
		sweeps++;
	}, 1000);

	await vi.advanceTimersByTimeAsync(10_000);

	expect(recoveryStarted).toBe(1);
	expect(sweeps).toBe(11);
});

test("a loop waits for its task to finish before scheduling the next run", async () => {
	vi.useFakeTimers();
	let runs = 0;
	startSweepLoop(async () => {
		runs++;
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}, 1000);

	await vi.advanceTimersByTimeAsync(12_000);

	// Runs start at 0, 6 and 12 seconds.
	expect(runs).toBe(3);
});

test("an interval loop runs now, then every interval, until stopped", async () => {
	vi.useFakeTimers();
	let runs = 0;
	const stop = startLoop(
		"test",
		collectingLogger().logger,
		async () => {
			runs++;
		},
		1000,
	);
	expect(runs).toBe(1);
	await vi.advanceTimersByTimeAsync(3000);
	expect(runs).toBe(4);
	stop();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(runs).toBe(4);
});

test("an interval loop skips a tick while the previous run is busy", async () => {
	vi.useFakeTimers();
	let runs = 0;
	startLoop(
		"test",
		collectingLogger().logger,
		async () => {
			runs++;
			await new Promise((resolve) => setTimeout(resolve, 2500));
		},
		1000,
	);

	await vi.advanceTimersByTimeAsync(5000);

	// Runs start at 0 and 3 seconds; the ticks at 1, 2, 4 and 5 find one busy.
	expect(runs).toBe(2);
});

test("an interval loop logs an escaped error under its name and keeps going", async () => {
	vi.useFakeTimers();
	const { logger, lines } = collectingLogger();
	let runs = 0;
	startLoop(
		"demo",
		logger,
		async () => {
			runs++;
			throw new Error("boom");
		},
		1000,
	);

	await vi.advanceTimersByTimeAsync(1000);

	expect(runs).toBe(2);
	const errors = lines.filter((l) => l.msg === "demo loop error");
	expect(errors).toHaveLength(2);
	expect(errors[0]?.level).toBe("error");
});

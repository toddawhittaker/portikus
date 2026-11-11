import { expect, test } from "vitest";
import {
	cpuLoad,
	loadLevel,
	STORAGE_POLL_MS,
	USAGE_POLL_MS,
	usagePollInterval,
} from "./usage.js";

test("the status bar asks every 2 s until its first sample, then every 30 s", () => {
	expect(usagePollInterval(false, STORAGE_POLL_MS)).toBe(2000);
	expect(usagePollInterval(true, STORAGE_POLL_MS)).toBe(30_000);
	// A faster poll is never slowed down.
	expect(usagePollInterval(false, USAGE_POLL_MS)).toBe(1000);
});

test("after a failure in the error state, the storage poll slows to 30 seconds", () => {
	expect(usagePollInterval(false, STORAGE_POLL_MS, true)).toBe(30_000);
});

test("a figure is high from half its limit and near the limit from four fifths", () => {
	expect(loadLevel(49, 100)).toBe("normal");
	expect(loadLevel(50, 100)).toBe("high");
	expect(loadLevel(79, 100)).toBe("high");
	expect(loadLevel(80, 100)).toBe("near-limit");
	expect(loadLevel(100, 100)).toBe("near-limit");
	// Over the limit is still near it.
	expect(loadLevel(150, 100)).toBe("near-limit");
});

test("a missing figure or a missing limit is never tinted", () => {
	expect(loadLevel(null, 100)).toBe("normal");
	expect(loadLevel(90, 0)).toBe("normal");
	expect(loadLevel(90, Number.NaN)).toBe("normal");
	expect(cpuLoad(null)).toBe("normal");
});

test("CPU is already a share of the workspace's CPUs, so one core of two is high", () => {
	expect(cpuLoad(50)).toBe("high");
	expect(cpuLoad(49.9)).toBe("normal");
	expect(cpuLoad(80)).toBe("near-limit");
});

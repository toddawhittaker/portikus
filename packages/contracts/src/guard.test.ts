import { describe, expect, test } from "vitest";
import { effectiveGuard } from "./guard.js";

const platform = {
	cpu_guard_threshold_percent: 80,
	memory_guard_threshold_percent: 90,
	guard_window_minutes: 30,
	cpu_throttle_share_percent: 25,
	idle_stop_minutes: 60,
};

describe("effectiveGuard", () => {
	test("with no overrides the platform values apply", () => {
		expect(effectiveGuard(platform, null)).toEqual({
			cpuThresholdPercent: 80,
			memoryThresholdPercent: 90,
			windowMinutes: 30,
			throttleSharePercent: 25,
			idleStopMinutes: 60,
		});
	});

	test("each override key wins, including an idle stop of 0", () => {
		expect(
			effectiveGuard(platform, { cpuThresholdPercent: 95, idleStopMinutes: 0 }),
		).toEqual({
			cpuThresholdPercent: 95,
			memoryThresholdPercent: 90,
			windowMinutes: 30,
			throttleSharePercent: 25,
			idleStopMinutes: 0,
		});
	});
});

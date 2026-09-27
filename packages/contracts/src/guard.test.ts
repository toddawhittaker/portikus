import { describe, expect, test } from "vitest";
import { effectiveGuard, idleLift, throttleHold } from "./guard.js";

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

describe("idleLift", () => {
	test("gives the minutes and percent when lifting is on", () => {
		expect(idleLift({ cpu_idle_lift_minutes: 5, cpu_idle_lift_percent: 10 })).toEqual({
			minutes: 5,
			percent: 10,
		});
	});

	test("percent 0 turns lifting off", () => {
		expect(idleLift({ cpu_idle_lift_minutes: 5, cpu_idle_lift_percent: 0 })).toBeNull();
	});
});

describe("throttleHold (SPEC.md §19.4)", () => {
	const hold = { cpu_throttle_hold_after: 3, cpu_throttle_hold_hours: 24 };
	const t = (hhmm: string) => new Date(`2026-09-27T${hhmm}:00Z`);

	test("the third throttle within the window is held", () => {
		const result = throttleHold(hold, [t("10:00"), t("13:00")], t("16:00"));
		expect(result.held).toEqual({ count: 3, hours: 24 });
		expect(result.recent).toEqual([t("10:00"), t("13:00"), t("16:00")]);
	});

	test("the second is not held", () => {
		expect(throttleHold(hold, [t("10:00")], t("13:00")).held).toBeNull();
	});

	test("throttles outside the window are dropped and do not count", () => {
		const old = new Date("2026-09-26T09:00:00Z");
		const result = throttleHold(hold, [old, t("10:00")], t("16:00"));
		expect(result.held).toBeNull();
		expect(result.recent).toEqual([t("10:00"), t("16:00")]);
	});

	test("a throttle exactly one window old no longer counts", () => {
		const edge = new Date("2026-09-26T16:00:00Z");
		expect(throttleHold(hold, [edge, t("10:00")], t("16:00")).held).toBeNull();
	});

	test("0 turns holding off, but the times are still kept", () => {
		const off = { ...hold, cpu_throttle_hold_after: 0 };
		const result = throttleHold(off, [t("10:00"), t("13:00")], t("16:00"));
		expect(result.held).toBeNull();
		expect(result.recent).toHaveLength(3);
	});
});

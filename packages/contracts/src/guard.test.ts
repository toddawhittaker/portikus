import { describe, expect, test } from "vitest";
import {
	allowanceFor,
	countIncusCpus,
	effectiveGuard,
	idleLift,
	keepRunningMaxHours,
	keepRunningRefusal,
	throttleHold,
} from "./guard.js";

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

test("allowanceFor is a time slice for a share of the CPUs", () => {
	expect(allowanceFor(25, 4)).toBe("100ms/100ms");
	expect(allowanceFor(25, 2)).toBe("50ms/100ms");
	expect(allowanceFor(100, 4)).toBe("400ms/100ms");
	expect(allowanceFor(5, 1)).toBe("5ms/100ms");
});

test("countIncusCpus reads a count or a CPU set, and null otherwise", () => {
	expect(countIncusCpus("4")).toBe(4);
	expect(countIncusCpus("0-3")).toBe(4);
	expect(countIncusCpus("0,2,5-6")).toBe(4);
	expect(countIncusCpus(undefined)).toBeNull();
	expect(countIncusCpus("")).toBeNull();
	expect(countIncusCpus("0")).toBeNull();
	expect(countIncusCpus("3-1")).toBeNull();
	expect(countIncusCpus("four")).toBeNull();
});

describe("keep running until", () => {
	const now = new Date("2026-10-01T12:00:00Z");
	const hours = (n: number) => new Date(now.getTime() + n * 3_600_000);

	test("a workspace override wins over the site cap, 0 included", () => {
		expect(keepRunningMaxHours(12, null)).toBe(12);
		expect(keepRunningMaxHours(12, {})).toBe(12);
		expect(keepRunningMaxHours(12, { keepRunningMaxHours: 24 })).toBe(24);
		expect(keepRunningMaxHours(12, { keepRunningMaxHours: 0 })).toBe(0);
	});

	test("a cap of 0 refuses every hold", () => {
		expect(keepRunningRefusal(hours(1), now, 0)).toBe("off");
	});

	test("a hold must end after now and never past the cap", () => {
		expect(keepRunningRefusal(now, now, 12)).toBe("past");
		expect(keepRunningRefusal(hours(-1), now, 12)).toBe("past");
		expect(keepRunningRefusal(hours(12), now, 12)).toBeNull();
		// Five minutes of clock skew past the cap is allowed; the caller clamps it.
		expect(
			keepRunningRefusal(new Date(hours(12).getTime() + 300_000), now, 12),
		).toBeNull();
		expect(keepRunningRefusal(new Date(hours(12).getTime() + 300_001), now, 12)).toBe(
			"too-far",
		);
		expect(keepRunningRefusal(hours(0.5), now, 12)).toBeNull();
	});
});

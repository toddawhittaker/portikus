import { expect, test } from "vitest";
import { guardDrafts, guardRequest, parseGuardValue } from "./GuardDialog.js";

test("each guard value keeps to the ranges the platform allows", () => {
	expect(parseGuardValue("cpuThresholdPercent", "1")).toBe(1);
	expect(parseGuardValue("cpuThresholdPercent", "100")).toBe(100);
	expect(parseGuardValue("cpuThresholdPercent", "101")).toBeNull();
	expect(parseGuardValue("windowMinutes", "4")).toBeNull();
	expect(parseGuardValue("windowMinutes", "240")).toBe(240);
	expect(parseGuardValue("throttleSharePercent", "5")).toBe(5);
	expect(parseGuardValue("throttleSharePercent", "4")).toBeNull();
	expect(parseGuardValue("idleStopMinutes", "0")).toBe(0);
	expect(parseGuardValue("idleStopMinutes", "9")).toBeNull();
	expect(parseGuardValue("idleStopMinutes", "1440")).toBe(1440);
	expect(parseGuardValue("idleStopMinutes", "1441")).toBeNull();
	expect(parseGuardValue("memoryThresholdPercent", "9.5")).toBeNull();
});

test("a blank field removes the override and a bad one names its range", () => {
	const drafts = guardDrafts({ windowMinutes: 45 });
	expect(drafts.windowMinutes).toBe("45");
	expect(drafts.cpuThresholdPercent).toBe("");
	expect(guardRequest(drafts)).toEqual({
		body: {
			cpuThresholdPercent: null,
			memoryThresholdPercent: null,
			windowMinutes: 45,
			throttleSharePercent: null,
			idleStopMinutes: null,
		},
	});
	expect(guardRequest({ ...drafts, throttleSharePercent: "2" })).toEqual({
		errors: { throttleSharePercent: "Enter a whole number from 5 to 100." },
	});
});

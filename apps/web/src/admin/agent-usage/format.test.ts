import { expect, test } from "vitest";
import { compact, cost, count, dayName, estimate } from "./format.js";

test("counts get thousands separators", () => {
	expect(count(1234567)).toBe("1,234,567");
	expect(count(0)).toBe("0");
});

test("a missing cost is a dash and a known one is dollars", () => {
	expect(cost(null)).toBe("—");
	expect(cost(0)).toBe("$0.00");
	expect(cost(12.345)).toBe("$12.35");
});

test("big totals read compactly", () => {
	expect(compact(1_234_567)).toBe("1.2M");
	expect(compact(12_502)).toBe("12.5K");
	expect(compact(980)).toBe("980");
});

test("a usage day reads as a weekday and date, in UTC like the day itself", () => {
	expect(dayName("2026-11-06")).toBe("Fri, Nov 6");
	expect(dayName("2026-11-06", true)).toBe("Fri 6");
});

test("an estimate is a dash when unpriced, and never a false zero", () => {
	expect(estimate(null)).toBe("—");
	expect(estimate(0)).toBe("$0.00");
	expect(estimate(0.003)).toBe("under $0.01");
	expect(estimate(2.335)).toBe("$2.34");
});

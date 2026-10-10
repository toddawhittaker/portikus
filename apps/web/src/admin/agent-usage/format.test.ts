import { expect, test } from "vitest";
import { cost, count } from "./format.js";

test("counts get thousands separators", () => {
	expect(count(1234567)).toBe("1,234,567");
	expect(count(0)).toBe("0");
});

test("a missing cost is a dash and a known one is dollars", () => {
	expect(cost(null)).toBe("—");
	expect(cost(0)).toBe("$0.00");
	expect(cost(12.345)).toBe("$12.35");
});

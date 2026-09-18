import { expect, test } from "vitest";
import { scrollRatio, scrollTopForRatio } from "./scrollSync.js";

test("the ratio is where the viewport sits in the scrollable range", () => {
	expect(scrollRatio(0, 1000, 200)).toBe(0);
	expect(scrollRatio(400, 1000, 200)).toBe(0.5);
	expect(scrollRatio(800, 1000, 200)).toBe(1);
});

test("content that fits has no range, so the ratio is zero", () => {
	expect(scrollRatio(0, 200, 200)).toBe(0);
	expect(scrollRatio(50, 100, 400)).toBe(0);
});

test("a ratio out of range or not a number is clamped", () => {
	expect(scrollRatio(-50, 1000, 200)).toBe(0);
	expect(scrollRatio(5000, 1000, 200)).toBe(1);
	expect(scrollRatio(Number.NaN, 1000, 200)).toBe(0);
	expect(scrollTopForRatio(-1, 1000, 200)).toBe(0);
	expect(scrollTopForRatio(2, 1000, 200)).toBe(800);
	expect(scrollTopForRatio(Number.NaN, 1000, 200)).toBe(0);
});

test("a ratio turns back into the offset it came from", () => {
	const ratio = scrollRatio(300, 2000, 500);
	expect(scrollTopForRatio(ratio, 2000, 500)).toBeCloseTo(300);
	// The two sides differ in height, so the same ratio is a different offset.
	expect(scrollTopForRatio(ratio, 4000, 400)).toBeCloseTo(0.2 * 3600);
});

test("a side with nothing to scroll stays at the top", () => {
	expect(scrollTopForRatio(0.5, 300, 300)).toBe(0);
});

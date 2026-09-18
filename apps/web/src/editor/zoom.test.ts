import { describe, expect, it } from "vitest";
import {
	BASE_FONT_SIZE,
	clampZoom,
	DEFAULT_ZOOM,
	fontSizeFor,
	MAX_ZOOM,
	MIN_ZOOM,
	stepZoom,
} from "./zoom.js";

/** Editor-only zoom state (SPEC.md §13.1). */
describe("zoom", () => {
	it("starts at 100%", () => {
		expect(DEFAULT_ZOOM).toBe(100);
		expect(fontSizeFor(DEFAULT_ZOOM)).toBe(BASE_FONT_SIZE);
	});

	it("steps by ten percent in each direction", () => {
		expect(stepZoom(100, 1)).toBe(110);
		expect(stepZoom(100, -1)).toBe(90);
		expect(stepZoom(100, 3)).toBe(130);
	});

	it("stops at the ends of the range", () => {
		expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
		expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
		expect(clampZoom(1000)).toBe(MAX_ZOOM);
		expect(clampZoom(0)).toBe(MIN_ZOOM);
	});

	it("falls back to 100% for a value that is not a number", () => {
		expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM);
	});

	it("turns a percentage into a whole font size", () => {
		expect(fontSizeFor(200)).toBe(BASE_FONT_SIZE * 2);
		expect(fontSizeFor(50)).toBe(Math.round(BASE_FONT_SIZE / 2));
		expect(Number.isInteger(fontSizeFor(115))).toBe(true);
	});
});

import { expect, test } from "vitest";
import { graceMinutes, graceText, parseGraceMinutes } from "./graceText.js";

test("zero means the workspace is never stopped for being idle", () => {
	expect(graceText(0)).toBe("Workspaces keep running until stopped by hand");
});

test("whole minutes and hours read as words", () => {
	expect(graceText(600)).toBe("10 minutes");
	expect(graceText(60)).toBe("1 minute");
	expect(graceText(3600)).toBe("1 hour");
	expect(graceText(5400)).toBe("1 hour 30 minutes");
});

test("leftover seconds are kept", () => {
	expect(graceText(30)).toBe("30 seconds");
	expect(graceText(1)).toBe("1 second");
	expect(graceText(3661)).toBe("1 hour 1 minute 1 second");
});

test("graceMinutes shows whole minutes plainly and odd seconds to two places", () => {
	expect(graceMinutes(600)).toBe("10");
	expect(graceMinutes(0)).toBe("0");
	expect(graceMinutes(90)).toBe("1.5");
	expect(graceMinutes(100)).toBe("1.67");
});

test("parseGraceMinutes turns minutes into whole seconds", () => {
	expect(parseGraceMinutes("10")).toBe(600);
	expect(parseGraceMinutes(" 0 ")).toBe(0);
	expect(parseGraceMinutes("1.5")).toBe(90);
	// A shown value saves back to the seconds it came from.
	expect(parseGraceMinutes(graceMinutes(100))).toBe(100);
});

test("parseGraceMinutes refuses words, negatives and values past the column's limit", () => {
	expect(parseGraceMinutes("")).toBeNull();
	expect(parseGraceMinutes("soon")).toBeNull();
	expect(parseGraceMinutes("-5")).toBeNull();
	expect(parseGraceMinutes("1e3")).toBeNull();
	expect(parseGraceMinutes("35791394")).toBe(2147483640);
	expect(parseGraceMinutes("35791395")).toBeNull();
});

import { expect, test } from "vitest";
import { defaultLabel, graceText } from "./graceText.js";

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

test("defaultLabel names the platform value in words", () => {
	expect(defaultLabel(600)).toBe("Default (10 minutes)");
	expect(defaultLabel(5400)).toBe("Default (1 hour 30 minutes)");
});

test("defaultLabel says indefinite for zero", () => {
	expect(defaultLabel(0)).toBe("Default (indefinite)");
});

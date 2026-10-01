import { expect, test } from "vitest";
import { joinWords, plural, shortTime, timeAgo } from "./text.js";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");

test("timeAgo uses full words, singular and plural", () => {
	expect(timeAgo(null, NOW)).toBe("—");
	expect(timeAgo(undefined, NOW)).toBe("—");
	expect(timeAgo("2026-09-22T11:59:40.000Z", NOW)).toBe("Just now");
	expect(timeAgo("2026-09-22T11:59:00.000Z", NOW)).toBe("1 minute ago");
	expect(timeAgo("2026-09-22T11:56:00.000Z", NOW)).toBe("4 minutes ago");
	expect(timeAgo("2026-09-22T11:00:00.000Z", NOW)).toBe("1 hour ago");
	expect(timeAgo("2026-09-22T09:00:00.000Z", NOW)).toBe("3 hours ago");
	expect(timeAgo("2026-09-21T11:00:00.000Z", NOW)).toBe("1 day ago");
	expect(timeAgo("2026-08-22T11:00:00.000Z", NOW)).toBe("31 days ago");
	// A clock a little ahead of the browser's never reads as the future.
	expect(timeAgo("2026-09-22T12:05:00.000Z", NOW)).toBe("Just now");
});

test("shortTime gives month, day and time", () => {
	const text = shortTime("2026-09-22T10:00:00.000Z");
	expect(text).toMatch(/Sep/);
	expect(text).toMatch(/22/);
});

test("plural adds an s, or uses the given plural", () => {
	expect(plural(1, "host")).toBe("1 host");
	expect(plural(0, "host")).toBe("0 hosts");
	expect(plural(2, "kept home", "kept homes")).toBe("2 kept homes");
});

test("joinWords lists words with commas and a final and or or", () => {
	expect(joinWords([])).toBe("");
	expect(joinWords(["A"])).toBe("A");
	expect(joinWords(["A", "B"])).toBe("A and B");
	expect(joinWords(["A", "B", "C"])).toBe("A, B and C");
	expect(joinWords(["Error", "Warn"], "or")).toBe("Error or Warn");
});

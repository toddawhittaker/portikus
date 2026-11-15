import { expect, test } from "vitest";
import { formatDuration, plainOutput } from "./historyText.js";

test("terminal escapes and carriage returns are removed from kept output", () => {
	expect(plainOutput("\x1b[1;31mFAIL\x1b[0m a.test\r\n\x1b]0;title\x07ok\r")).toBe(
		"FAIL a.test\nok\n",
	);
});

test("durations read in the unit a student expects", () => {
	expect(formatDuration(850)).toBe("850 ms");
	expect(formatDuration(2400)).toBe("2.4 s");
	expect(formatDuration(120_000)).toBe("2 min");
	expect(formatDuration(185_000)).toBe("3 min 5 s");
});

import { expect, test } from "vitest";
import { exitLines, wrapAtSpaces } from "./CheckOutput.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

test("a passed run ends on a green line with its exit code", () => {
	expect(exitLines(false, 0, 80)).toBe(
		`${GREEN}[portikus] check passed (exit code 0)${RESET}`,
	);
});

test("a failed run ends on a red line with its exit code", () => {
	expect(exitLines(false, 2, 80)).toBe(
		`${RED}[portikus] check failed (exit code 2)${RESET}`,
	);
});

test("a stopped run ends on a yellow line, whatever its exit code", () => {
	expect(exitLines(true, 143, 80)).toBe(
		`${YELLOW}[portikus] check stopped (exit code 143)${RESET}`,
	);
});

test("in a narrow panel the closing line breaks at spaces, each piece coloured", () => {
	expect(exitLines(false, 0, 30)).toBe(
		`${GREEN}[portikus] check passed (exit${RESET}\r\n${GREEN}code 0)${RESET}`,
	);
});

test("text is broken only at spaces, never inside a word", () => {
	expect(wrapAtSpaces("one two three four", 9)).toEqual(["one two", "three", "four"]);
	expect(wrapAtSpaces("short", 80)).toEqual(["short"]);
	// A word longer than the line is kept whole rather than split.
	expect(wrapAtSpaces("a verylongword b", 5)).toEqual(["a", "verylongword", "b"]);
});

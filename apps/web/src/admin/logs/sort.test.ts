import type { LogLine } from "@portikus/contracts";
import { expect, test } from "vitest";
import { logsCaption } from "./LogResults.js";
import { DEFAULT_LOG_SORT, sortLogLines } from "./sort.js";

function line(
	cursor: string,
	at: string,
	service: LogLine["service"],
	body: Record<string, unknown>,
): LogLine {
	return { cursor, at, service, line: body, userName: null };
}

// Newest first, as the journal returns them.
const LINES = [
	line("a", "2026-10-03T10:03:00.000Z", "worker", { level: "info", code: "B_CODE" }),
	line("b", "2026-10-03T10:02:00.000Z", "api", { level: "error", status: 500 }),
	line("c", "2026-10-03T10:01:00.000Z", "controller", { level: "debug", status: 404 }),
	line("d", "2026-10-03T10:00:00.000Z", "api", {
		level: "warn",
		status: 200,
		code: "A_CODE",
	}),
];

function cursors(lines: LogLine[]): string[] {
	return lines.map((item) => item.cursor);
}

test("the default is the journal's newest first; ascending puts the oldest first", () => {
	expect(cursors(sortLogLines(LINES, DEFAULT_LOG_SORT))).toEqual(["a", "b", "c", "d"]);
	expect(
		cursors(sortLogLines(LINES, { column: "time", direction: "ascending" })),
	).toEqual(["d", "c", "b", "a"]);
});

test("Level sorts by severity, not by the word", () => {
	expect(
		cursors(sortLogLines(LINES, { column: "level", direction: "descending" })),
	).toEqual(["b", "d", "a", "c"]);
});

test("Status sorts as a number, and lines with none go last", () => {
	expect(
		cursors(sortLogLines(LINES, { column: "status", direction: "descending" })),
	).toEqual(["b", "c", "d", "a"]);
	expect(
		cursors(sortLogLines(LINES, { column: "status", direction: "ascending" })),
	).toEqual(["d", "c", "b", "a"]);
});

test("Service and Code sort by their words, ties in journal order", () => {
	expect(
		cursors(sortLogLines(LINES, { column: "service", direction: "ascending" })),
	).toEqual(["b", "d", "c", "a"]);
	expect(
		cursors(sortLogLines(LINES, { column: "code", direction: "ascending" })),
	).toEqual(["d", "a", "b", "c"]);
});

test("the caption says when the loaded lines are in another order", () => {
	expect(logsCaption(DEFAULT_LOG_SORT)).toBe("Log lines, newest first");
	expect(logsCaption({ column: "level", direction: "descending" })).toBe(
		"Loaded log lines, sorted by Level, descending",
	);
});

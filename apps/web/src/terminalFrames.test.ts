import { expect, test } from "vitest";
import {
	decodeTerminalFrame,
	firstNoticeOf,
	terminalGoneMessage,
} from "./terminalFrames.js";

test("an error frame carries the reason a terminal vanished", () => {
	const frame = decodeTerminalFrame(
		JSON.stringify({
			type: "error",
			code: "TERMINAL_NOT_FOUND",
			reason: "out_of_memory",
			at: "2026-09-26T10:00:00.000Z",
		}),
	);
	expect(frame).toEqual({
		kind: "error",
		code: "TERMINAL_NOT_FOUND",
		reason: "out_of_memory",
		at: "2026-09-26T10:00:00.000Z",
	});
});

test("an unknown reason is dropped", () => {
	expect(
		decodeTerminalFrame(
			JSON.stringify({ type: "error", code: "TERMINAL_NOT_FOUND", reason: "aliens" }),
		),
	).toEqual({ kind: "error", code: "TERMINAL_NOT_FOUND" });
});

test("each reason has its sentence", () => {
	expect(terminalGoneMessage("out_of_memory")).toBe(
		"Your workspace ran out of memory, so its terminals were closed.",
	);
	expect(terminalGoneMessage("restarted")).toBe(
		"Your workspace's terminals were closed.",
	);
});

test("a restart is told once", () => {
	expect(firstNoticeOf("2026-09-26T11:00:00.000Z")).toBe(true);
	expect(firstNoticeOf("2026-09-26T11:00:00.000Z")).toBe(false);
	expect(firstNoticeOf("2026-09-26T12:00:00.000Z")).toBe(true);
});

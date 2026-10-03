import { expect, test } from "vitest";
import {
	decodeTerminalFrame,
	firstNoticeOf,
	forgetAgentBuild,
	terminalGoneMessage,
	upgradedAgentNotice,
} from "./terminalFrames.js";

test("an agent frame names the running agent build", () => {
	expect(decodeTerminalFrame(JSON.stringify({ type: "agent", build: "b1" }))).toEqual({
		kind: "agent",
		build: "b1",
	});
	expect(decodeTerminalFrame(JSON.stringify({ type: "agent", build: "" }))).toEqual({
		kind: "ignored",
	});
	expect(decodeTerminalFrame(JSON.stringify({ type: "agent" }))).toEqual({
		kind: "ignored",
	});
});

test("a new agent build under an open page is told once per workspace", () => {
	// The first build a page sees is where it started, not an upgrade.
	expect(upgradedAgentNotice("ws-1", "b1")).toBe(false);
	expect(upgradedAgentNotice("ws-1", "b1")).toBe(false);
	expect(upgradedAgentNotice("ws-1", "b2")).toBe(true);
	// Every other pane reconnecting to the same new agent stays quiet.
	expect(upgradedAgentNotice("ws-1", "b2")).toBe(false);
	// Another workspace starts from its own first build.
	expect(upgradedAgentNotice("ws-2", "b2")).toBe(false);
	expect(upgradedAgentNotice("ws-2", "b1")).toBe(true);
});

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

test("a workspace whose terminals are gone starts over, so a fresh start is no upgrade", () => {
	expect(upgradedAgentNotice("ws-gone", "old")).toBe(false);
	expect(upgradedAgentNotice("ws-gone", "new")).toBe(true);
	forgetAgentBuild("ws-gone");
	// The workspace stopped and started: the first build heard again is the baseline.
	expect(upgradedAgentNotice("ws-gone", "newer")).toBe(false);
	expect(upgradedAgentNotice("ws-gone", "new")).toBe(true);
});

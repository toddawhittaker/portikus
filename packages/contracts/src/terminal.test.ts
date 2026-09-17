import { expect, test } from "vitest";
import {
	CreateTerminalRequest,
	MAX_ATTACHMENTS_PER_TERMINAL,
	MAX_INPUT_FRAME_BYTES,
	MAX_TERMINALS_PER_WORKSPACE,
	RenameTerminalRequest,
	Terminal,
	TerminalList,
} from "./index.js";

const sampleTerminal = {
	id: "550e8400-e29b-41d4-a716-446655440000",
	workspaceId: "550e8400-e29b-41d4-a716-446655440111",
	name: "shell",
	cwd: "/home/student/projects/demo",
	position: 0,
	createdAt: "2026-01-01T00:00:00.000Z",
	endedAt: null,
};

test("Terminal round-trips a complete record", () => {
	expect(Terminal.parse(sampleTerminal)).toEqual(sampleTerminal);
});

test("Terminal rejects an empty or over-long name", () => {
	expect(Terminal.safeParse({ ...sampleTerminal, name: "" }).success).toBe(false);
	expect(Terminal.safeParse({ ...sampleTerminal, name: "x".repeat(65) }).success).toBe(
		false,
	);
});

test("Terminal rejects a negative or fractional position", () => {
	expect(Terminal.safeParse({ ...sampleTerminal, position: -1 }).success).toBe(false);
	expect(Terminal.safeParse({ ...sampleTerminal, position: 1.5 }).success).toBe(false);
});

test("Terminal accepts an ended terminal", () => {
	const ended = { ...sampleTerminal, endedAt: "2026-01-01T01:00:00.000Z" };
	expect(Terminal.parse(ended)).toEqual(ended);
});

test("CreateTerminalRequest accepts an empty body and rejects extras", () => {
	expect(CreateTerminalRequest.parse({})).toEqual({});
	expect(CreateTerminalRequest.parse({ name: "build" })).toEqual({ name: "build" });
	expect(CreateTerminalRequest.safeParse({ workspaceId: "x" }).success).toBe(false);
});

test("RenameTerminalRequest requires a name and rejects extras", () => {
	expect(RenameTerminalRequest.parse({ name: "tests" })).toEqual({ name: "tests" });
	expect(RenameTerminalRequest.safeParse({}).success).toBe(false);
	expect(RenameTerminalRequest.safeParse({ name: "a", cwd: "/tmp" }).success).toBe(
		false,
	);
});

test("TerminalList round-trips", () => {
	const input = { terminals: [sampleTerminal] };
	expect(TerminalList.parse(input)).toEqual(input);
});

test("limits match the agreed transport budget", () => {
	expect(MAX_TERMINALS_PER_WORKSPACE).toBe(8);
	expect(MAX_ATTACHMENTS_PER_TERMINAL).toBe(4);
	expect(MAX_INPUT_FRAME_BYTES).toBe(65536);
});

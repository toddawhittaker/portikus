import { expect, test } from "vitest";
import {
	CreateTerminalRequest,
	MAX_ATTACHMENTS_PER_TERMINAL,
	MAX_INPUT_FRAME_BYTES,
	MAX_TERMINALS_PER_WORKSPACE,
	Terminal,
	TerminalList,
	UpdateTerminalRequest,
} from "./index.js";

const sampleTerminal = {
	id: "550e8400-e29b-41d4-a716-446655440000",
	workspaceId: "550e8400-e29b-41d4-a716-446655440111",
	name: "shell",
	cwd: "/home/student/projects/demo",
	position: 0,
	projectId: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	endedAt: null,
	theme: "dark",
};

test("Terminal round-trips a complete record", () => {
	expect(Terminal.parse(sampleTerminal)).toEqual(sampleTerminal);
});

test("Terminal carries the project it belongs to", () => {
	const owned = {
		...sampleTerminal,
		projectId: "550e8400-e29b-41d4-a716-446655440222",
	};
	expect(Terminal.parse(owned)).toEqual(owned);
	expect(Terminal.safeParse({ ...sampleTerminal, projectId: "nope" }).success).toBe(
		false,
	);
});

test("CreateTerminalRequest accepts an optional projectId", () => {
	const projectId = "550e8400-e29b-41d4-a716-446655440222";
	expect(CreateTerminalRequest.parse({ projectId })).toEqual({ projectId });
	expect(CreateTerminalRequest.safeParse({ projectId: "nope" }).success).toBe(false);
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

test("UpdateTerminalRequest changes the name, the theme, or both", () => {
	expect(UpdateTerminalRequest.parse({ name: "tests" })).toEqual({ name: "tests" });
	expect(UpdateTerminalRequest.parse({ theme: "light" })).toEqual({ theme: "light" });
	expect(UpdateTerminalRequest.parse({ name: "a", theme: "dark" })).toEqual({
		name: "a",
		theme: "dark",
	});
	// A request that changes nothing, an unknown scheme, and an extra field.
	expect(UpdateTerminalRequest.safeParse({}).success).toBe(false);
	expect(UpdateTerminalRequest.safeParse({ theme: "sepia" }).success).toBe(false);
	expect(UpdateTerminalRequest.safeParse({ name: "a", cwd: "/tmp" }).success).toBe(
		false,
	);
});

// Issue #268: a terminal carries its own colour scheme.
test("Terminal requires a theme and a new terminal may ask for one", () => {
	const { theme: _theme, ...withoutTheme } = sampleTerminal;
	expect(Terminal.safeParse(withoutTheme).success).toBe(false);
	expect(CreateTerminalRequest.parse({ theme: "light" })).toEqual({ theme: "light" });
	expect(CreateTerminalRequest.safeParse({ theme: "sepia" }).success).toBe(false);
});

test("TerminalList round-trips", () => {
	const input = { terminals: [sampleTerminal] };
	expect(TerminalList.parse(input)).toEqual(input);
});

const sha1 = "a".repeat(40);
const sha256 = "b".repeat(64);

test("CreateTerminalRequest accepts a launcher agent and rejects anything else", () => {
	expect(CreateTerminalRequest.parse({ agent: "claude" })).toEqual({ agent: "claude" });
	expect(CreateTerminalRequest.parse({ agent: "codex" })).toEqual({ agent: "codex" });
	expect(CreateTerminalRequest.parse({})).toEqual({});
	expect(CreateTerminalRequest.safeParse({ agent: "gemini" }).success).toBe(false);
	expect(
		CreateTerminalRequest.safeParse({ agent: "claude", command: "claude" }).success,
	).toBe(false);
});

test("Terminal carries an optional review baseline", () => {
	expect(Terminal.parse(sampleTerminal)).toEqual(sampleTerminal);
	const recorded = {
		...sampleTerminal,
		agent: "claude" as const,
		baselineObjectId: sha1,
		baselineHead: sha256,
	};
	expect(Terminal.parse(recorded)).toEqual(recorded);
	expect(
		Terminal.parse({
			...sampleTerminal,
			agent: null,
			baselineObjectId: null,
			baselineHead: null,
		}),
	).toEqual({
		...sampleTerminal,
		agent: null,
		baselineObjectId: null,
		baselineHead: null,
	});
	expect(Terminal.safeParse({ ...sampleTerminal, agent: "gemini" }).success).toBe(
		false,
	);
	expect(
		Terminal.safeParse({ ...sampleTerminal, baselineObjectId: "abc" }).success,
	).toBe(false);
	expect(Terminal.safeParse({ ...sampleTerminal, baselineHead: "HEAD" }).success).toBe(
		false,
	);
});

test("limits match the agreed transport budget", () => {
	expect(MAX_TERMINALS_PER_WORKSPACE).toBe(20);
	expect(MAX_ATTACHMENTS_PER_TERMINAL).toBe(4);
	expect(MAX_INPUT_FRAME_BYTES).toBe(65536);
});

test("Terminal carries the recovery point made before its agent session", () => {
	const withPoint = {
		...sampleTerminal,
		agent: "claude",
		recoveryPointId: "550e8400-e29b-41d4-a716-446655440222",
	};
	expect(Terminal.parse(withPoint)).toEqual(withPoint);
	expect(
		Terminal.parse({ ...sampleTerminal, recoveryPointId: null }).recoveryPointId,
	).toBe(null);
	expect(Terminal.safeParse({ ...sampleTerminal, recoveryPointId: "x" }).success).toBe(
		false,
	);
});

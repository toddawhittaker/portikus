import { expect, test } from "vitest";
import {
	ClientMessage,
	ServerMessage,
	TerminalClientMessage,
	TerminalServerMessage,
} from "./index.js";

const workspace = {
	id: "550e8400-e29b-41d4-a716-446655440000",
	ownerUserId: "550e8400-e29b-41d4-a716-446655440111",
	state: "running" as const,
	desiredState: "running" as const,
	incusInstanceName: "ws-abc123",
	imageVersion: null,
	quotaConfig: { homeGiB: 25, dockerGiB: 20 },
	errorCode: null,
	errorMessage: null,
	activeConnections: 1,
	lastActiveConnectionAt: null,
	shutdownDeadline: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

test("ClientMessage accepts a heartbeat", () => {
	expect(ClientMessage.parse({ type: "heartbeat" })).toEqual({
		type: "heartbeat",
	});
});

test("ClientMessage rejects an unknown type", () => {
	expect(ClientMessage.safeParse({ type: "resize" }).success).toBe(false);
});

test("ServerMessage round-trips a workspace message", () => {
	const input = { type: "workspace" as const, workspace };
	expect(ServerMessage.parse(input)).toEqual(input);
});

test("ServerMessage rejects a workspace message with no workspace", () => {
	expect(ServerMessage.safeParse({ type: "workspace" }).success).toBe(false);
});

test("TerminalClientMessage accepts input and resize", () => {
	expect(TerminalClientMessage.parse({ type: "input", data: "ls\n" })).toEqual({
		type: "input",
		data: "ls\n",
	});
	expect(TerminalClientMessage.parse({ type: "resize", cols: 80, rows: 24 })).toEqual({
		type: "resize",
		cols: 80,
		rows: 24,
	});
});

test("TerminalClientMessage rejects out-of-range and unknown frames", () => {
	expect(
		TerminalClientMessage.safeParse({ type: "resize", cols: 0, rows: 24 }).success,
	).toBe(false);
	expect(
		TerminalClientMessage.safeParse({ type: "resize", cols: 80, rows: 1001 }).success,
	).toBe(false);
	expect(
		TerminalClientMessage.safeParse({ type: "resize", cols: 80.5, rows: 24 }).success,
	).toBe(false);
	expect(TerminalClientMessage.safeParse({ type: "output", data: "x" }).success).toBe(
		false,
	);
});

test("TerminalServerMessage accepts exit and a known error code", () => {
	expect(TerminalServerMessage.parse({ type: "exit" })).toEqual({ type: "exit" });
	expect(
		TerminalServerMessage.parse({ type: "error", code: "ATTACHMENT_LIMIT" }),
	).toEqual({ type: "error", code: "ATTACHMENT_LIMIT" });
	expect(TerminalServerMessage.safeParse({ type: "error", code: "NOPE" }).success).toBe(
		false,
	);
});

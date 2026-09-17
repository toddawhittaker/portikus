import { expect, test } from "vitest";
import {
	AgentCreateTerminalRequest,
	AgentError,
	AgentHealthResponse,
	AgentTerminalList,
	StartInstanceRequest,
} from "./index.js";

const terminalId = "550e8400-e29b-41d4-a716-446655440000";

test("AgentHealthResponse accepts only ok true", () => {
	expect(AgentHealthResponse.parse({ ok: true })).toEqual({ ok: true });
	expect(AgentHealthResponse.safeParse({ ok: false }).success).toBe(false);
});

test("AgentTerminalList round-trips", () => {
	const input = {
		terminals: [{ id: terminalId, cwd: "/home/student", attachments: 2 }],
	};
	expect(AgentTerminalList.parse(input)).toEqual(input);
});

test("AgentCreateTerminalRequest requires an id and a cwd", () => {
	const input = { id: terminalId, cwd: "/home/student" };
	expect(AgentCreateTerminalRequest.parse(input)).toEqual(input);
	expect(AgentCreateTerminalRequest.safeParse({ cwd: "/home/student" }).success).toBe(
		false,
	);
	expect(
		AgentCreateTerminalRequest.safeParse({ ...input, name: "shell" }).success,
	).toBe(false);
});

test("AgentError round-trips and rejects an unknown code", () => {
	const input = { error: { code: "TERMINAL_LIMIT" as const, message: "too many" } };
	expect(AgentError.parse(input)).toEqual(input);
	expect(AgentError.safeParse({ error: { code: "BOOM", message: "x" } }).success).toBe(
		false,
	);
});

test("StartInstanceRequest requires a 64-character hex agent token", () => {
	const token = "a".repeat(64);
	expect(StartInstanceRequest.parse({ agentToken: token })).toEqual({
		agentToken: token,
		timeoutSeconds: 60,
	});
	expect(StartInstanceRequest.safeParse({}).success).toBe(false);
	expect(StartInstanceRequest.safeParse({ agentToken: "a".repeat(63) }).success).toBe(
		false,
	);
	expect(StartInstanceRequest.safeParse({ agentToken: "A".repeat(64) }).success).toBe(
		false,
	);
});

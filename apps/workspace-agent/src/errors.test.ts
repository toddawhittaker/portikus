import type { FastifyReply, FastifyRequest } from "fastify";
import { expect, test } from "vitest";
import { ERROR_STATUS, sendError } from "./errors.js";
import { AgentFailure } from "./tmux.js";

function stubs() {
	const logged: unknown[] = [];
	const sent: { code?: number; body?: unknown } = {};
	const reply = {
		code(status: number) {
			sent.code = status;
			return this;
		},
		send(body: unknown) {
			sent.body = body;
			return this;
		},
	} as unknown as FastifyReply;
	const request = {
		log: { error: (...args: unknown[]) => logged.push(args) },
	} as unknown as FastifyRequest;
	return { request, reply, sent, logged };
}

test("an expected failure keeps its code, status, and message", () => {
	const { request, reply, sent, logged } = stubs();
	sendError(request, reply, new AgentFailure("SEARCH_FAILED", "search failed"));
	expect(sent.code).toBe(ERROR_STATUS.SEARCH_FAILED);
	expect(sent.body).toEqual({
		error: { code: "SEARCH_FAILED", message: "search failed" },
	});
	// An expected failure is already on the body, so it is not logged twice.
	expect(logged).toHaveLength(0);
});

test("an unexpected Error never puts its message on the body", () => {
	const { request, reply, sent, logged } = stubs();
	sendError(request, reply, new Error("secret token abc123 in /home/u/.env"));
	expect(sent.code).toBe(500);
	expect(sent.body).toEqual({
		error: { code: "TMUX_FAILED", message: "internal error" },
	});
	expect(JSON.stringify(sent.body)).not.toContain("abc123");
	expect(logged).toHaveLength(1);
});

test("an unexpected filesystem error logs its code and syscall, never the path", () => {
	const { request, reply, logged } = stubs();
	const error = Object.assign(
		new Error("EACCES: permission denied, open '/home/u/projects/secret-plan.md'"),
		{ code: "EACCES", syscall: "open", path: "/home/u/projects/secret-plan.md" },
	);
	sendError(request, reply, error, "INTERNAL");
	expect(logged).toEqual([
		[{ errorCode: "EACCES", syscall: "open" }, "agent request failed"],
	]);
	expect(JSON.stringify(logged)).not.toContain("secret-plan");
});

test("a thrown value that is not an Error is still handled", () => {
	const { request, reply, sent, logged } = stubs();
	sendError(request, reply, { odd: true });
	expect(sent.code).toBe(500);
	expect(sent.body).toEqual({
		error: { code: "TMUX_FAILED", message: "internal error" },
	});
	expect(logged).toHaveLength(1);
});

test("every agent error code maps to a client or server status", () => {
	for (const [code, status] of Object.entries(ERROR_STATUS)) {
		expect(status, code).toBeGreaterThanOrEqual(400);
		expect(status, code).toBeLessThan(600);
	}
	expect(ERROR_STATUS.UNAUTHORIZED).toBe(401);
	expect(ERROR_STATUS.PROJECT_NOT_FOUND).toBe(404);
});

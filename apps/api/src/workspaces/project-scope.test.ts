import type { FastifyReply } from "fastify";
import { describe, expect, test, vi } from "vitest";
import { AgentCallError } from "../agent-client.js";
import { sendAgentError } from "./project-scope.js";

function fakeReply() {
	const reply = { status: vi.fn(), send: vi.fn() };
	reply.status.mockReturnValue(reply);
	return reply;
}

describe("sendAgentError", () => {
	test("reports an agent-side INTERNAL failure as a 500, not as unreachable", () => {
		const reply = fakeReply();
		sendAgentError(
			reply as unknown as FastifyReply,
			new AgentCallError("INTERNAL", "boom"),
		);
		expect(reply.status).toHaveBeenCalledWith(500);
		expect(reply.send).toHaveBeenCalledWith({ code: "INTERNAL", message: "boom" });
	});

	test("still reports an unreachable agent as AGENT_UNAVAILABLE", () => {
		const reply = fakeReply();
		sendAgentError(
			reply as unknown as FastifyReply,
			new AgentCallError("AGENT_UNAVAILABLE", "timed out"),
		);
		expect(reply.status).toHaveBeenCalledWith(503);
	});
});

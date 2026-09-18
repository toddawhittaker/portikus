import type { AgentErrorCode } from "@portikus/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AgentFailure } from "./tmux.js";

/** The HTTP status each agent failure maps to (SPEC.md §27). */
export const ERROR_STATUS: Record<AgentErrorCode, number> = {
	BAD_REQUEST: 400,
	UNAUTHORIZED: 401,
	TERMINAL_NOT_FOUND: 404,
	TERMINAL_EXISTS: 409,
	TERMINAL_LIMIT: 409,
	ATTACHMENT_LIMIT: 409,
	INVALID_CWD: 400,
	TMUX_FAILED: 500,
	PROJECT_EXISTS: 409,
	PROJECT_NOT_FOUND: 404,
	INVALID_SLUG: 400,
	INVALID_URL: 400,
	GIT_FAILED: 500,
	SEARCH_FAILED: 500,
};

/** Turn a failure into a response body that never carries internal detail. */
export function sendError(
	request: FastifyRequest,
	reply: FastifyReply,
	error: unknown,
) {
	if (error instanceof AgentFailure) {
		return reply
			.code(ERROR_STATUS[error.code])
			.send({ error: { code: error.code, message: error.message } });
	}
	// An expected failure needs no log call: its code and message are on the
	// body, which the request logging hook reads. An unexpected one does,
	// because its real message never reaches the body.
	request.log.error(
		{ error: error instanceof Error ? error.message : String(error) },
		"agent request failed",
	);
	return reply.code(500).send({
		error: { code: "TMUX_FAILED", message: "internal error" },
	});
}

import type { AgentErrorCode } from "@portikus/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { FileChanged } from "./files.js";
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
	INTERNAL: 500,
	PATH_INVALID: 400,
	FILE_NOT_FOUND: 404,
	FILE_EXISTS: 409,
	FILE_CHANGED: 412,
	FILE_TOO_LARGE: 413,
	NOT_A_DIRECTORY: 400,
	SEARCH_FAILED: 500,
	WATCH_FAILED: 500,
	EVENT_SOCKET_LIMIT: 409,
	CHECK_NOT_FOUND: 404,
	CHECK_RUNNING: 409,
	CHECK_NOT_RUNNING: 404,
	LISTENER_NOT_FOUND: 404,
	LISTENER_IS_SYSTEM: 403,
	STOP_FAILED: 409,
	BUSY: 409,
	STORAGE_FULL: 507,
	RECOVERY_POINT_INVALID: 422,
	RESTORE_INCOMPLETE: 500,
	ROLLBACK_COPY_EXISTS: 409,
};

/**
 * Turn a failure into a response body that never carries internal detail. An
 * unexpected error from a file route is INTERNAL rather than TMUX_FAILED,
 * which belongs to the terminal paths (SPEC.md §27).
 */
export function sendError(
	request: FastifyRequest,
	reply: FastifyReply,
	error: unknown,
	fallback: AgentErrorCode = "TMUX_FAILED",
) {
	if (error instanceof FileChanged) {
		reply.header("etag", error.etag);
	}
	if (error instanceof AgentFailure) {
		return reply
			.code(ERROR_STATUS[error.code])
			.send({ error: { code: error.code, message: error.message } });
	}
	// An expected failure needs no log call: its code and message are on the
	// body, which the request logging hook reads. An unexpected one does,
	// because its real message never reaches the body. Only the code and
	// syscall are logged, since a filesystem message carries a path (ADR 0012).
	const { code, syscall } = (error ?? {}) as NodeJS.ErrnoException;
	request.log.error(
		{ errorCode: typeof code === "string" ? code : undefined, syscall },
		"agent request failed",
	);
	return reply.code(500).send({
		error: { code: fallback, message: "internal error" },
	});
}

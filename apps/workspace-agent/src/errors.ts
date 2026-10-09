import type { AgentErrorCode } from "@portikus/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";

/** An agent failure carrying the wire error code of SPEC.md §27. */
export class AgentFailure extends Error {
	readonly code: AgentErrorCode;

	constructor(code: AgentErrorCode, message: string) {
		super(message);
		this.name = "AgentFailure";
		this.code = code;
	}
}

/**
 * A stale conditional write. It carries the file's current etag so the route
 * can return it as an ETag header and the editor can recover (SPEC.md §13.5).
 */
export class FileChanged extends AgentFailure {
	readonly etag: string;

	constructor(etag: string) {
		super("FILE_CHANGED", "the file changed on disk since it was read");
		this.name = "FileChanged";
		this.etag = etag;
	}
}

/** The errno name a filesystem or child-process error carries, if any. */
export function errorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null | undefined)?.code;
	return typeof code === "string" ? code : undefined;
}

/** A full disk or an exhausted quota (SPEC.md §13.5). */
export function isNoSpace(error: unknown): boolean {
	const code = errorCode(error);
	return code === "ENOSPC" || code === "EDQUOT";
}

/** Whether a child process's stderr reports a full disk or quota. */
export function saysNoSpace(stderr: string): boolean {
	return /No space left on device|Disk quota exceeded/i.test(stderr);
}

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
	DIRECTORY_EXISTS: 409,
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
	FORWARD_UNAVAILABLE: 409,
	FORWARD_NOT_LOOPBACK: 409,
	FORWARD_PORT_IN_USE: 409,
	FORWARD_FAILED: 409,
	FORWARD_NOT_FOUND: 404,
	PROCESS_NOT_FOUND: 404,
	PROCESS_CHANGED: 409,
	PROCESS_PROTECTED: 403,
	BUSY: 409,
	STORAGE_FULL: 507,
	RECOVERY_POINT_INVALID: 422,
	RESTORE_INCOMPLETE: 500,
	ROLLBACK_COPY_EXISTS: 409,
	ARCHIVE_INVALID: 422,
};

/**
 * A signal that aborts when the caller goes away before the response has
 * finished, so long work started for it (ripgrep, zip, unzip, tar) stops.
 */
export function abortOnDisconnect(reply: FastifyReply): AbortSignal {
	const controller = new AbortController();
	reply.raw.once("close", () => {
		if (!reply.raw.writableFinished) controller.abort();
	});
	return controller.signal;
}

/**
 * Turn a failure into a response body that never carries internal detail. An
 * unexpected error from a file or project route is INTERNAL, not TMUX_FAILED,
 * which belongs to the terminal paths (SPEC.md §27).
 */
export function sendError(
	request: FastifyRequest,
	reply: FastifyReply,
	error: unknown,
	fallback: AgentErrorCode = "INTERNAL",
) {
	if (error instanceof FileChanged) {
		reply.header("etag", error.etag);
	}
	if (error instanceof AgentFailure) {
		return reply
			.code(ERROR_STATUS[error.code])
			.send({ error: { code: error.code, message: error.message } });
	}
	// A full disk or quota is the student's to fix, whichever route hit it
	// (SPEC.md §13.5).
	if (isNoSpace(error)) {
		return reply.code(ERROR_STATUS.STORAGE_FULL).send({
			error: { code: "STORAGE_FULL", message: "no space left in the home folder" },
		});
	}
	// An expected failure needs no log call: its code and message are on the
	// body, which the request logging hook reads. An unexpected one does,
	// because its real message never reaches the body. Only the code and
	// syscall and the error's class name are logged, since a filesystem
	// message carries a path (ADR 0012).
	const { code, syscall, name } = (error ?? {}) as NodeJS.ErrnoException;
	request.log.error(
		{
			errorCode: typeof code === "string" ? code : undefined,
			syscall,
			errorName: typeof name === "string" ? name : undefined,
		},
		"agent request failed",
	);
	return reply.code(500).send({
		error: { code: fallback, message: "internal error" },
	});
}

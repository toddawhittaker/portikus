import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	FastifyBaseLogger,
	FastifyInstance,
	FastifyReply,
	FastifyRequest,
	RawServerDefault,
} from "fastify";
import { LogController } from "fastify";

interface CapturedError {
	code: string | null;
	message: string | null;
}

/**
 * Error details pulled off a response body, keyed by request. A WeakMap keeps
 * this out of the request type and lets the entry go when the request does.
 */
const captured = new WeakMap<FastifyRequest, CapturedError>();

/** Pick code and message out of the three error body shapes we produce. */
function readErrorBody(payload: string): CapturedError | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const body = parsed as Record<string, unknown>;
	const nested = body.error;
	if (typeof nested === "object" && nested !== null) {
		const inner = nested as Record<string, unknown>;
		return {
			code: typeof inner.code === "string" ? inner.code : null,
			message: typeof inner.message === "string" ? inner.message : null,
		};
	}
	const code = typeof body.code === "string" ? body.code : null;
	const message = typeof body.message === "string" ? body.message : null;
	if (code === null && message === null) return null;
	return { code, message };
}

/** Keep a long error message from swamping the line. */
const MAX_ERROR_LENGTH = 200;

function truncate(message: string): string {
	return message.length <= MAX_ERROR_LENGTH
		? message
		: `${message.slice(0, MAX_ERROR_LENGTH)}\u2026`;
}

function isJson(reply: FastifyReply): boolean {
	const type = reply.getHeader("content-type");
	return typeof type === "string" && type.includes("json");
}

/** The path without its query string, so no secret in a query is logged. */
function pathOf(request: FastifyRequest): string {
	const url = request.url;
	const query = url.indexOf("?");
	return query === -1 ? url : url.slice(0, query);
}

/**
 * Turns off Fastify's own "incoming request" and "request completed" pair, so
 * `registerRequestLogging` is the only source of request lines. Pass it as the
 * `logController` option: Fastify 5.12 deprecated the top-level
 * `disableRequestLogging` flag in favour of this (warning FSTDEP023).
 */
export function quietLogController(): LogController {
	return new LogController({ disableRequestLogging: true });
}

export interface RequestLoggingOptions {
	/** Paths logged at debug rather than info, such as health polls. */
	debugPaths: string[];
}

/**
 * Log one line per request. Build the server with
 * `disableRequestLogging: true` so Fastify's own pair of lines is off.
 */
export function registerRequestLogging<Log extends FastifyBaseLogger>(
	app: FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Log>,
	opts: RequestLoggingOptions,
): void {
	app.addHook("onSend", async (request, reply, payload) => {
		if (reply.statusCode >= 400 && typeof payload === "string" && isJson(reply)) {
			const details = readErrorBody(payload);
			if (details) captured.set(request, details);
		}
		return payload;
	});

	app.addHook("onResponse", async (request, reply) => {
		const path = pathOf(request);
		const status = reply.statusCode;
		const details = captured.get(request);
		const user = (request as { user?: { id?: string } }).user;
		const params = request.params as { id?: unknown } | undefined;

		const line: Record<string, unknown> = {
			method: request.method,
			route: request.routeOptions.url ?? null,
			path,
			status,
			durationMs: Math.round(reply.elapsedTime),
			reqId: request.id,
		};
		if (user && typeof user.id === "string") line.userId = user.id;
		// Only a workspace route's `:id` is a workspace id; /admin/users/:id is not.
		if (params && typeof params.id === "string" && path.startsWith("/workspaces/")) {
			line.workspaceId = params.id;
		}
		if (details?.code) line.code = details.code;
		if (details?.message) line.error = truncate(details.message);

		const log = request.log;
		if (status >= 500) log.error(line, "request");
		else if (status >= 400) log.warn(line, "request");
		else if (opts.debugPaths.includes(path)) log.debug(line, "request");
		else log.info(line, "request");
	});
}

import { createMcpHandler } from "@modelcontextprotocol/server";
import { bearerApiKey } from "@portikus/auth";
import type { ApiError } from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerDeps } from "../deps.js";
import { serveMcp } from "../mcp/bridge.js";
import { toAuthInfo } from "../mcp/caller.js";
import { mcpServerFactory } from "../mcp/server.js";

const NO_BATCH = {
	jsonrpc: "2.0",
	error: {
		code: -32600,
		message: "Invalid Request: batches are not supported; send one request per call",
	},
	id: null,
} as const;

const KEY_REQUIRED: ApiError = {
	code: "UNAUTHORIZED",
	message: "an API key is required",
};

/**
 * The MCP server at `/mcp` (SPEC.md sections 24.8 and 27). Only an API key
 * signs in here: a browser session gets 401, and so does a missing or bad
 * key, with a plain `WWW-Authenticate: Bearer` and no OAuth metadata, since
 * the site runs no OAuth for MCP. A request carrying any Origin but the
 * site's own is refused, so no other web page can drive it. A JSON-RPC batch
 * is refused too: one POST runs one tool call.
 */
export function registerMcpRoutes(
	app: FastifyInstance,
	deps: Pick<ServerDeps, "config" | "db">,
): void {
	const origin = new URL(deps.config.PUBLIC_URL).origin;
	const handler = createMcpHandler(mcpServerFactory(app, deps.db), {
		onerror: (error) => app.log.warn({ err: error }, "mcp request failed"),
	});
	app.addHook("onClose", () => handler.close());

	async function mcp(request: FastifyRequest, reply: FastifyReply) {
		const key = request.apiKey;
		const user = request.user;
		if (!key || !user) return reply.code(401).send(KEY_REQUIRED);
		const from = request.headers.origin;
		if (from !== undefined && from !== origin) {
			const body: ApiError = { code: "FORBIDDEN", message: "origin not allowed" };
			return reply.code(403).send(body);
		}
		// The per-key rate limit counts HTTP requests, and the SDK would run every
		// call in a batch for one of them (SPEC.md section 24.8).
		if (Array.isArray(request.body)) return reply.code(400).send(NO_BATCH);
		const secret = bearerApiKey(request.headers.authorization) ?? "";
		const userAgent = request.headers["user-agent"];
		return serveMcp(handler, request, reply, {
			origin,
			authInfo: toAuthInfo({
				apiKey: secret,
				userId: user.id,
				keyId: key.id,
				scope: key.scope,
				role: user.role,
				ip: request.ip,
				...(userAgent === undefined ? {} : { userAgent }),
			}),
		});
	}

	// A request without a key is refused one way, whichever check caught it
	// first (a session, the CSRF check, a sign-in gate): 401 naming the Bearer
	// scheme, so an MCP client knows a key is what it lacks.
	const onSend = (
		request: FastifyRequest,
		reply: FastifyReply,
		payload: unknown,
		done: (error: null, payload: unknown) => void,
	) => {
		if (request.apiKey || (reply.statusCode !== 401 && reply.statusCode !== 403)) {
			return done(null, payload);
		}
		reply.code(401).header("www-authenticate", "Bearer");
		done(null, JSON.stringify(KEY_REQUIRED));
	};
	app.route({ method: "POST", url: "/mcp", onSend, handler: mcp });
	app.route({
		method: "GET",
		url: "/mcp",
		exposeHeadRoute: false,
		onSend,
		handler: mcp,
	});
}

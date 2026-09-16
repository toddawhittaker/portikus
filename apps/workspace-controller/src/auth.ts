import * as crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Fastify preHandler that requires a valid bearer token on every
 * route except GET /health. Uses constant-time comparison for
 * equal-length tokens; rejects wrong-length tokens with a plain 401
 * to avoid timing leaks. Never logs the token.
 */
export function tokenAuth(token: string) {
	const tokenBuf = Buffer.from(token);

	return async function authenticate(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> {
		// GET /health is public. Match the routed URL, not the raw one,
		// so query strings or path tricks cannot widen the exemption.
		if (request.method === "GET" && request.routeOptions.url === "/health") {
			return;
		}

		const header = request.headers.authorization;
		if (!header?.startsWith("Bearer ")) {
			reply.code(401).send({ code: "UNAUTHORIZED", message: "missing token" });
			return;
		}

		const presented = Buffer.from(header.slice(7));
		if (presented.length !== tokenBuf.length) {
			reply.code(401).send({ code: "UNAUTHORIZED", message: "invalid token" });
			return;
		}

		if (!crypto.timingSafeEqual(presented, tokenBuf)) {
			reply.code(401).send({ code: "UNAUTHORIZED", message: "invalid token" });
			return;
		}
	};
}

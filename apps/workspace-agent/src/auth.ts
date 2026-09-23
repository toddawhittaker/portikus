import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Fastify onRequest hook requiring the per-workspace bearer token on every route,
 * `/health` and the WebSocket upgrade included (SPEC.md §23.5, §9.7).
 *
 * The token file is re-read on each request so that the control plane can
 * rotate it without restarting the agent. The token is never logged. Each
 * refusal returns the reply, which is what stops Fastify running the route.
 */
export function tokenAuth(tokenPath: string) {
	return async function authenticate(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<FastifyReply | undefined> {
		let expected: Buffer;
		try {
			expected = Buffer.from((await readFile(tokenPath, "utf8")).trim());
		} catch {
			return reply.code(401).send(unauthorized("no token configured"));
		}

		const header = request.headers.authorization;
		if (!header?.startsWith("Bearer ") || expected.length === 0) {
			return reply.code(401).send(unauthorized("missing token"));
		}

		// timingSafeEqual throws on a length mismatch, so check length first;
		// the length of a random hex token is not a secret.
		const presented = Buffer.from(header.slice(7));
		if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
			return reply.code(401).send(unauthorized("invalid token"));
		}
		return undefined;
	};
}

function unauthorized(message: string) {
	return { error: { code: "UNAUTHORIZED" as const, message } };
}

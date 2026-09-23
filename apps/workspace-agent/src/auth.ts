import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Fastify onRequest hook requiring the per-workspace bearer token on every route,
 * `/health` and the WebSocket upgrade included (SPEC.md §23.5, §9.7).
 *
 * The token file is re-read on each request so that the control plane can
 * rotate it without restarting the agent. The token is never logged.
 */
export function tokenAuth(tokenPath: string) {
	return async function authenticate(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> {
		let expected: Buffer;
		try {
			expected = Buffer.from((await readFile(tokenPath, "utf8")).trim());
		} catch {
			reply.code(401).send(unauthorized("no token configured"));
			return;
		}

		const header = request.headers.authorization;
		if (!header?.startsWith("Bearer ") || expected.length === 0) {
			reply.code(401).send(unauthorized("missing token"));
			return;
		}

		// timingSafeEqual throws on a length mismatch, so check length first;
		// the length of a random hex token is not a secret.
		const presented = Buffer.from(header.slice(7));
		if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
			reply.code(401).send(unauthorized("invalid token"));
			return;
		}
	};
}

function unauthorized(message: string) {
	return { error: { code: "UNAUTHORIZED" as const, message } };
}

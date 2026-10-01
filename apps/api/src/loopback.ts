import type { FastifyRequest } from "fastify";

/** The socket's own peer address is loopback; no header can influence it. */
export function fromLoopback(request: FastifyRequest): boolean {
	const address = request.raw.socket.remoteAddress ?? "";
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

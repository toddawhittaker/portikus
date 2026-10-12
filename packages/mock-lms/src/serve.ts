import { readFileSync } from "node:fs";
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** A plain HTTP server, or HTTPS when given a certificate and key (as a real LMS serves). */
export function createListener(
	handler: Handler,
	tls?: { certFile: string; keyFile: string },
): Server {
	const listener = (req: IncomingMessage, res: ServerResponse) =>
		void handler(req, res);
	if (!tls) return createHttpServer(listener);
	return createHttpsServer(
		{ cert: readFileSync(tls.certFile), key: readFileSync(tls.keyFile) },
		listener,
	);
}

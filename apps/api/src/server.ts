import { HealthResponse } from "@portikus/contracts";
import Fastify, { type FastifyInstance } from "fastify";

/** Build the control-plane HTTP server (SPEC.md section 2.8, STACK.md section 4). */
export function buildServer(): FastifyInstance {
	const app = Fastify({ logger: false });

	app.get("/health", () => {
		const body: HealthResponse = {
			status: "ok",
			service: "api",
			uptimeSeconds: process.uptime(),
		};
		return HealthResponse.parse(body);
	});

	return app;
}

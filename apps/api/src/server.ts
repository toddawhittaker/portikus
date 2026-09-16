import type { ApiConfig } from "@portikus/config";
import { type ApiError, HealthResponse } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import Fastify, { type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";

export interface ServerDeps {
	db: Kysely<Database>;
	config: ApiConfig;
}

/** Build the control-plane HTTP server (SPEC.md §2.8, STACK.md §4). */
export function buildServer(deps: ServerDeps): FastifyInstance {
	const app = Fastify({ logger: false });

	app.get("/health", () => {
		const body: HealthResponse = {
			status: "ok",
			service: "api",
			uptimeSeconds: process.uptime(),
		};
		return HealthResponse.parse(body);
	});

	// Never let a driver or runtime message reach the client (SPEC.md §24, §27).
	app.setErrorHandler((error, request, reply) => {
		console.error(
			JSON.stringify({
				msg: "unhandled request error",
				method: request.method,
				url: request.routeOptions.url ?? request.url,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		const body: ApiError = {
			code: "INTERNAL",
			message: "An unexpected error occurred. Please try again.",
		};
		reply.status(500).send(body);
	});

	registerWorkspaceRoutes(app, deps);

	return app;
}

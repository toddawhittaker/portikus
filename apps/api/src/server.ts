import type { ApiConfig } from "@portikus/config";
import { HealthResponse } from "@portikus/contracts";
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

	registerWorkspaceRoutes(app, deps);

	return app;
}

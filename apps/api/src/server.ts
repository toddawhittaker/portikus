import websocket from "@fastify/websocket";
import { authPlugin, type OidcClient } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import { type ApiError, HealthResponse } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import {
	type Logger,
	quietLogController,
	registerRequestLogging,
} from "@portikus/observability";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { toAuthOptions } from "./auth-options.js";
import { createListeningRegistry } from "./preview/registry.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAdminAuditRoutes } from "./routes/admin-audit.js";
import { registerAdminHealthRoutes } from "./routes/admin-health.js";
import { registerAdminWorkspaceRoutes } from "./routes/admin-workspaces.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCheckRoutes } from "./routes/checks.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerGitSearchRoutes } from "./routes/git-search.js";
import { registerMaintenanceRoutes } from "./routes/maintenance.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerPreviewRoutes } from "./routes/preview.js";
import { registerProjectEventsSocket } from "./routes/project-events.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerRecoveryRoutes } from "./routes/recovery.js";
import { registerTerminalRoutes } from "./routes/terminals.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerWorkspaceSocket } from "./routes/ws.js";

export interface ServerDeps {
	db: Kysely<Database>;
	config: ApiConfig;
	/** The one root logger of this process (ADR 0012). */
	logger: Logger;
	/** Tests inject a client bound to the mock provider. */
	oidc?: OidcClient;
	/** How often the listening registry looks for workspaces; tests go faster. */
	previewPollIntervalMs?: number;
}

/** Build the control-plane HTTP server (SPEC.md §2.8, STACK.md §4). */
export function buildServer(deps: ServerDeps): FastifyInstance {
	// Caddy on loopback is the only proxy, so trust its X-Forwarded-For and
	// nothing else; request.ip is then the real client (SPEC.md §24.11).
	// Widened to Fastify's own logger type so the instance keeps its default
	// generic; a pino logger satisfies it.
	const loggerInstance: FastifyBaseLogger = deps.logger;
	const app = Fastify({
		loggerInstance,
		logController: quietLogController(),
		trustProxy: "127.0.0.1",
	});

	// One line per response, including every 4xx the routes send (ADR 0012).
	registerRequestLogging(app, { debugPaths: ["/health"] });

	// A refused upgrade is answered with plain HTTP over a socket Fastify does
	// not track, so close it here or shutdown waits for it forever. Only that
	// case: a normal request may keep its connection alive.
	// A hijacked reply (an accepted upgrade) never reaches this hook.
	app.addHook("onResponse", async (request, reply) => {
		const upgrade = request.headers.upgrade;
		if (
			typeof upgrade === "string" &&
			upgrade.toLowerCase() === "websocket" &&
			reply.statusCode >= 400
		) {
			request.raw.socket.destroy();
		}
	});

	// The sign-out button is a plain HTML form, which browsers post as
	// urlencoded; no route reads its fields, so accept and discard the body.
	app.addContentTypeParser(
		"application/x-www-form-urlencoded",
		{ parseAs: "string" },
		(_request, _body, done) => done(null, {}),
	);

	app.register(authPlugin, { db: deps.db, auth: toAuthOptions(deps.config) });

	// Registered before @fastify/websocket so it runs before that plugin's own
	// preClose, which drops the sockets without a status code.
	app.addHook("preClose", async () => {
		const clients = app.websocketServer?.clients ?? [];
		await Promise.all(
			[...clients].map(
				(client) =>
					new Promise<void>((resolve) => {
						// Do not wait forever for a client that never answers.
						const timer = setTimeout(() => {
							client.terminate();
							resolve();
						}, 2000);
						client.once("close", () => {
							clearTimeout(timer);
							resolve();
						});
						client.close(1001, "server shutting down");
					}),
			),
		);
	});

	// One megabyte is the largest frame a browser may send us (SPEC.md §9.7).
	app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

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
		request.log.error({ err: error }, "unhandled request error");
		const body: ApiError = {
			code: "INTERNAL",
			message: "An unexpected error occurred. Please try again.",
		};
		reply.status(500).send(body);
	});

	// One websocket per running workspace tells the control plane what is
	// listening inside it (BROWSER-HANDLING.md §11.1).
	const registry = createListeningRegistry({
		db: deps.db,
		config: deps.config,
		logger: deps.logger,
		...(deps.previewPollIntervalMs === undefined
			? {}
			: { pollIntervalMs: deps.previewPollIntervalMs }),
	});
	app.addHook("onReady", async () => registry.start());
	app.addHook("onClose", async () => registry.stop());

	const routeDeps = { ...deps, registry };

	app.register(async (instance) => {
		registerAuthRoutes(instance, deps);
		registerWorkspaceRoutes(instance, deps);
		registerWorkspaceSocket(instance, routeDeps);
		registerPreviewRoutes(instance, routeDeps);
		registerTerminalRoutes(instance, deps);
		registerProjectRoutes(instance, deps);
		registerRecoveryRoutes(instance, deps);
		registerFileRoutes(instance, deps);
		registerGitSearchRoutes(instance, deps);
		registerCheckRoutes(instance, deps);
		registerUsageRoutes(instance, deps);
		registerProjectEventsSocket(instance, deps);
		registerMeRoutes(instance, deps);
		registerAdminRoutes(instance, deps);
		registerMaintenanceRoutes(instance, deps);
		registerAdminWorkspaceRoutes(instance, routeDeps);
		registerAdminAuditRoutes(instance, routeDeps);
		registerAdminHealthRoutes(instance, routeDeps);
	});

	return app;
}

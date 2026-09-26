import websocket from "@fastify/websocket";
import { authPlugin, type DexApi, type OidcClient } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import { type ApiError, HealthResponse } from "@portikus/contracts";
import { type Database, isDatabaseUnavailable } from "@portikus/db";
import {
	type Logger,
	quietLogController,
	registerRequestLogging,
} from "@portikus/observability";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { toAuthOptions } from "./auth-options.js";
import { createListeningRegistry } from "./preview/registry.js";
import { fileWriteLimit } from "./rate-limit.js";
import { registerAcceptableUseRoutes } from "./routes/acceptable-use.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAdminAuditRoutes } from "./routes/admin-audit.js";
import { registerAdminDexUserRoutes } from "./routes/admin-dex-users.js";
import { registerAdminHealthRoutes } from "./routes/admin-health.js";
import { registerAdminWorkspaceRoutes } from "./routes/admin-workspaces.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCheckRoutes } from "./routes/checks.js";
import { registerCourseRoutes } from "./routes/courses.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerGitSearchRoutes } from "./routes/git-search.js";
import { registerLinkRoutes } from "./routes/links.js";
import { type LtiDeps, registerLtiRoutes } from "./routes/lti.js";
import { registerMaintenanceRoutes } from "./routes/maintenance.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerMePasswordRoutes } from "./routes/me-password.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerPreviewRoutes } from "./routes/preview.js";
import { registerProjectEventsSocket } from "./routes/project-events.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerRecoveryRoutes } from "./routes/recovery.js";
import { registerTerminalRoutes } from "./routes/terminals.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerWorkspaceSocket } from "./routes/ws.js";
import {
	registerSigninThrottle,
	registerSigninThrottleRoute,
} from "./signin-throttle.js";

export interface ServerDeps {
	db: Kysely<Database>;
	config: ApiConfig;
	/** The one root logger of this process (ADR 0012). */
	logger: Logger;
	/** Tests inject a client bound to the mock provider. */
	oidc?: OidcClient;
	/** The registered LMS platforms; absent means LTI is off and /lti/* is 404. */
	lti?: LtiDeps;
	/** Dex's gRPC API; absent means the Dex user routes answer 404 (docs/archive/epics/EPIC-14.md ruling 24). */
	dex?: DexApi;
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

	// Browser forms post urlencoded: the sign-out button, whose fields no
	// route reads, and the LTI login and launch (docs/archive/epics/EPIC-13.md ruling 1).
	app.addContentTypeParser(
		"application/x-www-form-urlencoded",
		{ parseAs: "string" },
		(_request, body, done) =>
			done(null, Object.fromEntries(new URLSearchParams(body as string))),
	);

	// Before the auth plugin, so its hook runs first (issue #398).
	registerSigninThrottle(app, deps);

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

	// Never let a driver or runtime message reach the client (SPEC.md §24, §27).
	app.setErrorHandler((error, request, reply) => {
		// Fastify's own client errors (too large, bad JSON, wrong type) keep
		// their 4xx status; they are the caller's fault, not ours (issue #401).
		const status = (error as { statusCode?: unknown }).statusCode;
		const code = (error as { code?: unknown }).code;
		if (
			typeof status === "number" &&
			status >= 400 &&
			status < 500 &&
			typeof code === "string" &&
			code.startsWith("FST_")
		) {
			request.log.info({ code }, "request refused by fastify");
			const body: ApiError = {
				code: "VALIDATION_FAILED",
				message:
					status === 413
						? "The request body is too large."
						: "The request was not valid.",
			};
			reply.status(status).send(body);
			return;
		}
		if (isDatabaseUnavailable(error)) {
			request.log.warn("no database connection was available");
			const body: ApiError = {
				code: "SERVICE_BUSY",
				message: "The server is busy. Try again in a moment.",
			};
			reply.status(503).send(body);
			return;
		}
		request.log.error({ err: error }, "unhandled request error");
		const body: ApiError = {
			code: "INTERNAL",
			message: "An unexpected error occurred. Please try again.",
		};
		reply.status(500).send(body);
	});

	// Unmatched routes answer in the same shape as every other error.
	app.setNotFoundHandler((_request, reply) => {
		const body: ApiError = { code: "NOT_FOUND", message: "Not found." };
		reply.status(404).send(body);
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

	// Every route lives inside this plugin, so an onRoute hook added after
	// buildServer returns still sees all of them (authz-matrix.test.ts).
	// One file-write count for the files and projects routes together.
	const limitFileWrites = fileWriteLimit(deps.config);
	app.register(async (instance) => {
		instance.get("/health", () => {
			const body: HealthResponse = {
				status: "ok",
				service: "api",
				uptimeSeconds: process.uptime(),
			};
			return HealthResponse.parse(body);
		});
		registerAuthRoutes(instance, deps);
		registerSigninThrottleRoute(instance);
		registerLtiRoutes(instance, deps);
		registerCourseRoutes(instance, deps);
		registerWorkspaceRoutes(instance, deps);
		registerWorkspaceSocket(instance, routeDeps);
		registerPreviewRoutes(instance, routeDeps);
		registerTerminalRoutes(instance, deps);
		registerProjectRoutes(instance, deps, limitFileWrites);
		registerRecoveryRoutes(instance, deps);
		registerFileRoutes(instance, deps, limitFileWrites);
		registerGitSearchRoutes(instance, deps);
		registerCheckRoutes(instance, deps);
		registerUsageRoutes(instance, deps);
		registerProjectEventsSocket(instance, deps);
		registerMeRoutes(instance, deps);
		registerMePasswordRoutes(instance, deps);
		registerAcceptableUseRoutes(instance, deps);
		registerNotificationRoutes(instance, deps);
		registerLinkRoutes(instance, deps);
		registerAdminRoutes(instance, deps);
		registerAdminDexUserRoutes(instance, deps);
		registerMaintenanceRoutes(instance, deps);
		registerAdminWorkspaceRoutes(instance, routeDeps);
		registerAdminAuditRoutes(instance, routeDeps);
		registerAdminHealthRoutes(instance, routeDeps);
	});

	return app;
}

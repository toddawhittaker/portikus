import websocket from "@fastify/websocket";
import { authPlugin, type OidcClient } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import { type ApiError, HealthResponse } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import Fastify, { type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { toAuthOptions } from "./auth-options.js";
import { log } from "./log.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTerminalRoutes } from "./routes/terminals.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerWorkspaceSocket } from "./routes/ws.js";

export interface ServerDeps {
	db: Kysely<Database>;
	config: ApiConfig;
	/** Tests inject a client bound to the mock provider. */
	oidc?: OidcClient;
}

/** Build the control-plane HTTP server (SPEC.md §2.8, STACK.md §4). */
export function buildServer(deps: ServerDeps): FastifyInstance {
	// Caddy on loopback is the only proxy, so trust its X-Forwarded-For and
	// nothing else; request.ip is then the real client (SPEC.md §24.11).
	const app = Fastify({ logger: false, trustProxy: "127.0.0.1" });

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

	app.register(websocket);

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
		log("error", {
			msg: "unhandled request error",
			method: request.method,
			url: request.routeOptions.url ?? request.url,
			error: error instanceof Error ? error.message : String(error),
		});
		const body: ApiError = {
			code: "INTERNAL",
			message: "An unexpected error occurred. Please try again.",
		};
		reply.status(500).send(body);
	});

	app.register(async (instance) => {
		registerAuthRoutes(instance, deps);
		registerWorkspaceRoutes(instance, deps);
		registerWorkspaceSocket(instance, deps);
		registerTerminalRoutes(instance, deps);
		registerAdminRoutes(instance, deps);
	});

	return app;
}

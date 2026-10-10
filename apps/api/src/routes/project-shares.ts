import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../deps.js";

/** A student starts, reads and stops the share of one project (ADR 0057). No routes yet. */
export function registerProjectShareRoutes(
	_app: FastifyInstance,
	_deps: ServerDeps,
): void {}

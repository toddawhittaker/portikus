import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../deps.js";

/** Moving the site to a new host name or port as a trial (SPEC.md 20.1, ADR 0059). */
export function registerAdminAddressRoutes(
	_app: FastifyInstance,
	_deps: ServerDeps,
): void {}

import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../deps.js";

/** Host names the platform may reach through the egress proxy, added on the page (SPEC.md 20.1, ADR 0059). */
export function registerAdminProxyHostRoutes(
	_app: FastifyInstance,
	_deps: ServerDeps,
): void {}

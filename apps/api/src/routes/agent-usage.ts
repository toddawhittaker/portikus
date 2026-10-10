import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../deps.js";

/** Coding-agent usage for instructors and administrators (ADR 0057). No routes yet. */
export function registerAgentUsageRoutes(
	_app: FastifyInstance,
	_deps: ServerDeps,
): void {}

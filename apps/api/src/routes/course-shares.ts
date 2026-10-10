import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../deps.js";

/** An instructor's read-only view of projects shared in a course (ADR 0057). No routes yet. */
export function registerCourseShareRoutes(
	_app: FastifyInstance,
	_deps: ServerDeps,
): void {}

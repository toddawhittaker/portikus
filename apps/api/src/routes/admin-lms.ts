import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../deps.js";

/** LMS platforms the page registers for LTI launches (SPEC.md 20.1, ADR 0059). */
export function registerAdminLmsRoutes(
	_app: FastifyInstance,
	_deps: ServerDeps,
): void {}

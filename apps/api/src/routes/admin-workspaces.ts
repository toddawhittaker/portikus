import type { FastifyInstance } from "fastify";
import type { ListeningRegistry } from "../preview/registry.js";
import type { ServerDeps } from "../server.js";

/**
 * Admin workspace detail, archive, and quota routes (SPEC.md §20.1).
 * Epic 11 task 3 fills this in; it registers nothing yet.
 */
export function registerAdminWorkspaceRoutes(
	_app: FastifyInstance,
	_deps: ServerDeps & { registry: ListeningRegistry },
): void {}

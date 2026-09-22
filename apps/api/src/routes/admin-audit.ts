import type { FastifyInstance } from "fastify";
import type { ListeningRegistry } from "../preview/registry.js";
import type { ServerDeps } from "../server.js";

/**
 * `GET /admin/audit` (SPEC.md §24.11). Epic 11 task 4 fills this in; it
 * registers nothing yet.
 */
export function registerAdminAuditRoutes(
	_app: FastifyInstance,
	_deps: ServerDeps & { registry: ListeningRegistry },
): void {}

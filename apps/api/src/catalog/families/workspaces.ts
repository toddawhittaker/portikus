import type { OperationRecords } from "../types.js";

/** This family's operations, keyed by `"METHOD url"`; move each key out of `pending` as its record lands. */
export const operations: OperationRecords = {};

/** Routes of this family that are exposed but have no record yet. */
export const pending: readonly string[] = [
	"GET /admin/workspaces",
	"GET /workspaces/:id",
	"POST /workspaces/:id/start",
	"POST /workspaces/:id/stop",
	"POST /workspaces/:id/restart",
	"GET /admin/workspaces/:id",
	"GET /admin/workspaces/:id/agent-log",
	"POST /admin/workspaces/:id/archive",
	"POST /admin/workspaces/:id/unarchive",
	"POST /admin/workspaces/:id/lift-throttle",
	"POST /admin/workspaces/:id/clear-memory-flag",
	"POST /admin/workspaces/:id/reprovision",
	"PUT /admin/workspaces/:id/quota",
	"PUT /admin/workspaces/:id/guard",
	"PUT /admin/workspaces/:id/limits",
	"POST /admin/workspaces/:id/rebuild",
	"POST /workspaces/:id/reset-docker",
	"GET /admin/workspaces/:id/processes",
	"POST /admin/workspaces/:id/processes/refresh",
	"POST /admin/workspaces/:id/processes/:pid/stop",
];

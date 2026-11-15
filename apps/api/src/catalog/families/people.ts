import type { OperationRecords } from "../types.js";

/** This family's operations, keyed by `"METHOD url"`; move each key out of `pending` as its record lands. */
export const operations: OperationRecords = {};

/** Routes of this family that are exposed but have no record yet. */
export const pending: readonly string[] = [
	"GET /admin/users",
	"PUT /admin/users/:id/settings",
	"POST /admin/users/:id/disable",
	"POST /admin/users/:id/enable",
	"POST /admin/users/:id/promote",
	"POST /admin/users/:id/make-instructor",
	"POST /admin/users/:id/demote",
	"POST /admin/users/:id/remove-instructor",
	"GET /admin/settings",
	"PUT /admin/settings",
	"GET /admin/users/:id/links",
	"POST /admin/dex-users/:id/remove",
	"POST /admin/dex-users/:id/send-reset-link",
	"GET /admin/invitations",
	"POST /admin/invitations",
	"POST /admin/invitations/:id/revoke",
	"POST /admin/invitations/:id/send",
	"GET /admin/audit",
	"GET /admin/logs",
	"GET /admin/logs/counts",
	"GET /admin/health",
	"GET /admin/health/series",
	"POST /admin/alerts/test",
	"GET /admin/notifications",
	"GET /admin/packages",
	"GET /admin/agent-usage",
	"GET /admin/courses",
	"PUT /admin/courses/:courseId/profile",
];

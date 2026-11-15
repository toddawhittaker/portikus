import type { OperationRecords } from "../types.js";

/** This family's operations, keyed by `"METHOD url"`; move each key out of `pending` as its record lands. */
export const operations: OperationRecords = {};

/** Routes of this family that are exposed but have no record yet. */
export const pending: readonly string[] = [
	"GET /courses",
	"GET /courses/:courseId/members",
	"POST /courses/:courseId/members/:userId/remove",
	"PUT /courses/:courseId/profile",
	"POST /courses/:courseId/roster/sync",
	"GET /courses/:courseId/shares",
	"GET /courses/:courseId/shares/:projectId/checks",
	"GET /courses/:courseId/live-help",
	"GET /courses/:courseId/live-help/:sid",
	"POST /courses/:courseId/live-help/:sid/leave",
	"GET /courses/:courseId/live-help/:sid/listening",
	"GET /courses/:courseId/agent-usage",
	"GET /auth/me",
	"GET /me/notifications",
];

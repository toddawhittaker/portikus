import { requireUser } from "@portikus/auth";
import type { FastifyInstance } from "fastify";
import { syncCourseRoster } from "../courses/roster.js";
import { taughtCourseId } from "../courses/taught-course.js";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";

/**
 * Roster sync for a course's instructors (ADR 0058). A course whose
 * platform cannot sync answers 200 with `roster.available` false and
 * nothing changed.
 */
export function registerCourseRosterRoutes(
	app: FastifyInstance,
	{ db, config, lti }: ServerDeps,
): void {
	app.post("/courses/:courseId/roster/sync", async (request, reply) => {
		const user = requireUser(request);
		const courseId = await taughtCourseId(db, request);
		if (!courseId) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const body = await syncCourseRoster(
			{ db, lti, proxyUrl: config.OUTBOUND_PROXY_URL ?? null, log: request.log },
			courseId,
			`user:${user.id}`,
		);
		return reply.send(body);
	});
}

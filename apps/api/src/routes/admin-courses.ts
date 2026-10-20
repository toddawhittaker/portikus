import { requireRole, requireUser } from "@portikus/auth";
import {
	type AdminCoursesResponse,
	CourseProfile,
	type CourseProfileResponse,
	SetCourseProfileRequest,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { setCourseProfile } from "../courses/profile.js";
import type { ServerDeps } from "../deps.js";
import { parseOr400, sendError } from "../http.js";

const adminOnly = { preHandler: requireRole("administrator") };

const CourseParam = z.object({ courseId: z.string().uuid() });

/**
 * The administrator's view of every course and its profile (SPEC.md §8.7,
 * §20.1). Setting one calls the same function as the instructor's route.
 */
export function registerAdminCourseRoutes(
	app: FastifyInstance,
	{ db }: ServerDeps,
): void {
	app.get("/admin/courses", adminOnly, async (_request, reply) => {
		const rows = await db
			.selectFrom("lti_contexts")
			.select(["id", "title", "platform_name", "profile"])
			.orderBy("title")
			.orderBy("id")
			.execute();
		const body: AdminCoursesResponse = rows.map((row) => ({
			id: row.id,
			title: row.title,
			platformName: row.platform_name,
			profile: CourseProfile.parse(row.profile),
		}));
		return reply.send(body);
	});

	app.put("/admin/courses/:courseId/profile", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const params = CourseParam.safeParse(request.params);
		if (!params.success) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const body = parseOr400(SetCourseProfileRequest, request.body ?? {}, reply);
		if (!body) return reply;
		const updated = await setCourseProfile(db, {
			courseId: params.data.courseId,
			profile: body.profile,
			actorUserId: admin.id,
		});
		if (!updated) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const out: CourseProfileResponse = updated;
		return reply.send(out);
	});
}

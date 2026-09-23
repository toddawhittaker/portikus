import { requireUser } from "@portikus/auth";
import {
	type ApiError,
	CourseMemberRole,
	type CourseMembersResponse,
	type CoursesResponse,
	WorkspaceState,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerDeps } from "../server.js";

const CourseParam = z.object({ courseId: z.string().uuid() });

/**
 * The read-only Course page (docs/EPIC-13.md ruling 23). Only a course's
 * instructors see it; for anyone else it does not exist. No email, user id,
 * subject or workspace id ever leaves here.
 */
export function registerCourseRoutes(app: FastifyInstance, { db }: ServerDeps): void {
	app.get("/courses", async (request, reply) => {
		const user = requireUser(request);
		const rows = await db
			.selectFrom("lti_memberships")
			.innerJoin("lti_contexts", "lti_contexts.id", "lti_memberships.context_id")
			.select(["lti_contexts.id", "lti_contexts.title", "lti_contexts.platform_name"])
			.where("lti_memberships.user_id", "=", user.id)
			.where("lti_memberships.role", "=", "instructor")
			.orderBy("lti_contexts.title")
			.execute();
		const body: CoursesResponse = rows.map((row) => ({
			id: row.id,
			title: row.title,
			platformName: row.platform_name,
		}));
		return reply.send(body);
	});

	app.get("/courses/:courseId/members", async (request, reply) => {
		const user = requireUser(request);
		const notFound: ApiError = { code: "NOT_FOUND", message: "Not found." };
		const params = CourseParam.safeParse(request.params);
		if (!params.success) return reply.status(404).send(notFound);
		const { courseId } = params.data;

		const course = await db
			.selectFrom("lti_memberships")
			.innerJoin("lti_contexts", "lti_contexts.id", "lti_memberships.context_id")
			.select(["lti_contexts.id", "lti_contexts.title", "lti_contexts.platform_name"])
			.where("lti_memberships.context_id", "=", courseId)
			.where("lti_memberships.user_id", "=", user.id)
			.where("lti_memberships.role", "=", "instructor")
			.executeTakeFirst();
		if (!course) return reply.status(404).send(notFound);

		const members = await db
			.selectFrom("lti_memberships")
			.innerJoin("users", "users.id", "lti_memberships.user_id")
			.leftJoin("workspaces", "workspaces.owner_user_id", "users.id")
			.select([
				"users.display_name",
				"lti_memberships.role",
				"lti_memberships.last_launch_at",
				"workspaces.state",
			])
			.where("lti_memberships.context_id", "=", courseId)
			.orderBy("lti_memberships.role")
			.orderBy("users.display_name")
			.execute();

		const body: CourseMembersResponse = {
			course: {
				id: course.id,
				title: course.title,
				platformName: course.platform_name,
			},
			members: members.map((row) => ({
				displayName: row.display_name,
				role: CourseMemberRole.parse(row.role),
				lastLaunchAt: new Date(row.last_launch_at).toISOString(),
				workspaceState: row.state === null ? null : WorkspaceState.parse(row.state),
			})),
		};
		return reply.send(body);
	});
}

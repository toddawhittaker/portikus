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
import { audit } from "./start-session.js";

const CourseParam = z.object({ courseId: z.string().uuid() });
const MemberParam = z.object({
	courseId: z.string().uuid(),
	userId: z.string().uuid(),
});

/**
 * The read-only Course page (docs/EPIC-13.md ruling 23). Only a course's
 * instructors see it; for anyone else it does not exist. No email, user id,
 * subject or workspace id ever leaves here; the member's user id does, so an
 * instructor can remove them.
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
				"users.id",
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
				userId: row.id,
				displayName: row.display_name,
				role: CourseMemberRole.parse(row.role),
				lastLaunchAt: new Date(row.last_launch_at).toISOString(),
				workspaceState: row.state === null ? null : WorkspaceState.parse(row.state),
			})),
		};
		return reply.send(body);
	});

	// Deletes one membership row and nothing else; a relaunch from the LMS adds it back.
	app.post("/courses/:courseId/members/:userId/remove", async (request, reply) => {
		const user = requireUser(request);
		const notFound: ApiError = { code: "NOT_FOUND", message: "Not found." };
		const params = MemberParam.safeParse(request.params);
		if (!params.success) return reply.status(404).send(notFound);
		const { courseId, userId } = params.data;

		const teaches = await db
			.selectFrom("lti_memberships")
			.select("user_id")
			.where("context_id", "=", courseId)
			.where("user_id", "=", user.id)
			.where("role", "=", "instructor")
			.executeTakeFirst();
		if (!teaches) return reply.status(404).send(notFound);
		if (userId === user.id) {
			const self: ApiError = {
				code: "VALIDATION_FAILED",
				message: "You cannot remove yourself from a course.",
			};
			return reply.status(400).send(self);
		}

		const removed = await db.transaction().execute(async (trx) => {
			const result = await trx
				.deleteFrom("lti_memberships")
				.where("context_id", "=", courseId)
				.where("user_id", "=", userId)
				.executeTakeFirst();
			if (result.numDeletedRows === 0n) return false;
			// Ids only: no names, emails or subjects (ADR 0012).
			await audit(trx, "course.member_removed", `user:${user.id}`, userId, "ok", {
				contextId: courseId,
			});
			return true;
		});
		if (!removed) return reply.status(404).send(notFound);
		return reply.send({});
	});
}

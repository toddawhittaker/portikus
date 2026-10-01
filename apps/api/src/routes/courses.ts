import { requireUser } from "@portikus/auth";
import {
	CourseMemberRole,
	type CourseMembersResponse,
	type CoursesResponse,
	WorkspaceState,
} from "@portikus/contracts";
import { recordAudit } from "@portikus/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendError } from "../http.js";
import type { ServerDeps } from "../server.js";

const CourseParam = z.object({ courseId: z.string().uuid() });
const MemberParam = z.object({
	courseId: z.string().uuid(),
	userId: z.string().uuid(),
});

/**
 * The read-only Course page. Only a course's
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
		const params = CourseParam.safeParse(request.params);
		if (!params.success) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const { courseId } = params.data;

		const course = await db
			.selectFrom("lti_memberships")
			.innerJoin("lti_contexts", "lti_contexts.id", "lti_memberships.context_id")
			.select(["lti_contexts.id", "lti_contexts.title", "lti_contexts.platform_name"])
			.where("lti_memberships.context_id", "=", courseId)
			.where("lti_memberships.user_id", "=", user.id)
			.where("lti_memberships.role", "=", "instructor")
			.executeTakeFirst();
		if (!course) return sendError(reply, 404, "NOT_FOUND", "Not found.");

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
		const params = MemberParam.safeParse(request.params);
		if (!params.success) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const { courseId, userId } = params.data;

		const teaches = await db
			.selectFrom("lti_memberships")
			.select("user_id")
			.where("context_id", "=", courseId)
			.where("user_id", "=", user.id)
			.where("role", "=", "instructor")
			.executeTakeFirst();
		if (!teaches) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		if (userId === user.id) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"You cannot remove yourself from a course.",
			);
		}

		const removed = await db.transaction().execute(async (trx) => {
			// Only students are removed; an instructor's membership is the LMS's to change.
			const target = await trx
				.selectFrom("lti_memberships")
				.select("role")
				.where("context_id", "=", courseId)
				.where("user_id", "=", userId)
				.forUpdate()
				.executeTakeFirst();
			if (!target) return "not_found";
			if (target.role !== "student") return "instructor";
			await trx
				.deleteFrom("lti_memberships")
				.where("context_id", "=", courseId)
				.where("user_id", "=", userId)
				.execute();
			// Ids only: no names, emails or subjects (ADR 0012).
			await recordAudit(trx, {
				actor: `user:${user.id}`,
				target: userId,
				action: "course.member_removed",
				result: "ok",
				metadata: {
					contextId: courseId,
				},
			});
			return "removed";
		});
		if (removed === "not_found")
			return sendError(reply, 404, "NOT_FOUND", "Not found.");
		if (removed === "instructor") {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"Only students can be removed from a course. Instructors are managed in the LMS.",
			);
		}
		return reply.send({});
	});
}

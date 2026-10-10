import { requireUser } from "@portikus/auth";
import {
	type CourseMember,
	CourseMemberRole,
	type CourseMembersResponse,
	type CoursesResponse,
	WorkspaceState,
} from "@portikus/contracts";
import { recordAudit } from "@portikus/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { teachesCourse } from "../courses/membership.js";
import {
	courseRoster,
	membershipSubjects,
	rosterIsStale,
	selectRosterCourse,
	syncCourseRoster,
} from "../courses/roster.js";
import { taughtCourseId } from "../courses/taught-course.js";
import type { ServerDeps } from "../deps.js";
import { sendError } from "../http.js";

const MemberParam = z.object({
	courseId: z.string().uuid(),
	userId: z.string().uuid(),
});

/**
 * The Course page. Only a course's instructors see it; for anyone else it
 * does not exist. No email, subject or workspace id ever leaves here; the
 * member's user id does, so an instructor can remove them. People on the
 * LMS roster who never launched show as not started (ADR 0058).
 */
export function registerCourseRoutes(
	app: FastifyInstance,
	{ db, config, lti }: ServerDeps,
): void {
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
		const courseId = await taughtCourseId(db, request);
		if (!courseId) return sendError(reply, 404, "NOT_FOUND", "Not found.");

		const course = await selectRosterCourse(db, courseId)
			.select(["title", "platform_name"])
			.executeTakeFirstOrThrow();
		// Opening the page refreshes a stale roster in the background (ADR 0058).
		if (rosterIsStale(lti, course)) {
			syncCourseRoster(
				{ db, lti, proxyUrl: config.OUTBOUND_PROXY_URL ?? null, log: app.log },
				courseId,
				`user:${user.id}`,
			).catch((error: unknown) =>
				app.log.error({ err: error, courseId }, "roster refresh failed"),
			);
		}

		const active = await db
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
			.execute();
		// Someone who launched since the last sync is a member now, not a roster row.
		const launched = new Set(
			(await membershipSubjects(db, courseId, course.platform_issuer)).flatMap(
				(membership) => membership.subjects,
			),
		);
		const rosterOnly = await db
			.selectFrom("lti_roster_members")
			.select(["subject", "display_name", "role"])
			.where("context_id", "=", courseId)
			.execute();

		const members: CourseMember[] = [
			...active.map(
				(row): CourseMember => ({
					status: "active",
					userId: row.id,
					displayName: row.display_name,
					role: CourseMemberRole.parse(row.role),
					lastLaunchAt: new Date(row.last_launch_at).toISOString(),
					workspaceState: row.state === null ? null : WorkspaceState.parse(row.state),
				}),
			),
			...rosterOnly
				.filter((row) => !launched.has(row.subject))
				.map(
					(row): CourseMember => ({
						status: "not_started",
						userId: null,
						displayName: row.display_name,
						role: CourseMemberRole.parse(row.role),
						lastLaunchAt: null,
						workspaceState: null,
					}),
				),
		];
		members.sort(
			(a, b) =>
				a.role.localeCompare(b.role) || a.displayName.localeCompare(b.displayName),
		);

		const body: CourseMembersResponse = {
			course: { id: courseId, title: course.title, platformName: course.platform_name },
			roster: courseRoster(lti, course),
			members,
		};
		return reply.send(body);
	});

	// Deletes one membership row and nothing else; a relaunch from the LMS adds it back.
	app.post("/courses/:courseId/members/:userId/remove", async (request, reply) => {
		const user = requireUser(request);
		const params = MemberParam.safeParse(request.params);
		if (!params.success) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const { courseId, userId } = params.data;

		if (!(await teachesCourse(db, { userId: user.id, courseId }))) {
			return sendError(reply, 404, "NOT_FOUND", "Not found.");
		}
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

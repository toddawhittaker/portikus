import { requireUser } from "@portikus/auth";
import type { LiveHelpAudienceCourse, ShareAudienceCourse } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { z } from "zod";

const CourseParam = z.object({ courseId: z.string().uuid() });

/** True when the user holds an instructor membership in the course (ADR 0025). */
export async function teachesCourse(
	db: Kysely<Database>,
	{ userId, courseId }: { userId: string; courseId: string },
): Promise<boolean> {
	const row = await db
		.selectFrom("lti_memberships")
		.select("user_id")
		.where("context_id", "=", courseId)
		.where("user_id", "=", userId)
		.where("role", "=", "instructor")
		.executeTakeFirst();
	return row !== undefined;
}

/**
 * True when the instructor teaches the course and the member holds any
 * membership in it: the only way an instructor may see a student's shared
 * project or usage (SPEC.md §5.2, ADR 0057).
 */
export async function sharesCourseWith(
	db: Kysely<Database>,
	{
		instructorId,
		memberId,
		courseId,
	}: { instructorId: string; memberId: string; courseId: string },
): Promise<boolean> {
	const row = await db
		.selectFrom("lti_memberships as teacher")
		.innerJoin("lti_memberships as member", "member.context_id", "teacher.context_id")
		.select("member.user_id")
		.where("teacher.context_id", "=", courseId)
		.where("teacher.user_id", "=", instructorId)
		.where("teacher.role", "=", "instructor")
		.where("member.user_id", "=", memberId)
		.executeTakeFirst();
	return row !== undefined;
}

/**
 * Every course the user belongs to, by title, with the names of its other
 * instructors: exactly who `sharesCourseWith` lets see the user's shared
 * project (SPEC.md §5.2, ADR 0057).
 */
export async function shareAudience(
	db: Kysely<Database>,
	userId: string,
): Promise<ShareAudienceCourse[]> {
	const courses = await liveHelpAudience(db, userId);
	return courses.map((course) => ({
		courseId: course.courseId,
		courseTitle: course.courseTitle,
		instructors: course.instructors.map((one) => one.displayName),
	}));
}

/**
 * The same courses and instructors as `shareAudience`, with each
 * instructor's user id, which a live help start names (ADR 0063).
 */
export async function liveHelpAudience(
	db: Kysely<Database>,
	userId: string,
): Promise<LiveHelpAudienceCourse[]> {
	const rows = await db
		.selectFrom("lti_memberships as own")
		.innerJoin("lti_contexts", "lti_contexts.id", "own.context_id")
		.leftJoin("lti_memberships as teacher", (join) =>
			join
				.onRef("teacher.context_id", "=", "own.context_id")
				.on("teacher.role", "=", "instructor")
				.on("teacher.user_id", "!=", userId),
		)
		.leftJoin("users", "users.id", "teacher.user_id")
		.select([
			"lti_contexts.id",
			"lti_contexts.title",
			"users.id as user_id",
			"users.display_name",
		])
		.where("own.user_id", "=", userId)
		.orderBy("lti_contexts.title")
		.orderBy("lti_contexts.id")
		.orderBy("users.display_name")
		.execute();
	const courses = new Map<string, LiveHelpAudienceCourse>();
	for (const row of rows) {
		let course = courses.get(row.id);
		if (!course) {
			course = { courseId: row.id, courseTitle: row.title, instructors: [] };
			courses.set(row.id, course);
		}
		if (row.user_id !== null && row.display_name !== null) {
			course.instructors.push({ userId: row.user_id, displayName: row.display_name });
		}
	}
	return [...courses.values()];
}

/**
 * The `:courseId` of a request whose caller teaches that course, or null:
 * for anyone else the course does not exist (ADR 0025).
 */
export async function taughtCourseId(
	db: Kysely<Database>,
	request: FastifyRequest,
): Promise<string | null> {
	const user = requireUser(request);
	const params = CourseParam.safeParse(request.params);
	if (!params.success) return null;
	const { courseId } = params.data;
	return (await teachesCourse(db, { userId: user.id, courseId })) ? courseId : null;
}

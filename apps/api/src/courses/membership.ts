import type { ShareAudienceCourse } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";

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
		.select(["lti_contexts.id", "lti_contexts.title", "users.display_name"])
		.where("own.user_id", "=", userId)
		.orderBy("lti_contexts.title")
		.orderBy("lti_contexts.id")
		.orderBy("users.display_name")
		.execute();
	const courses = new Map<string, ShareAudienceCourse>();
	for (const row of rows) {
		let course = courses.get(row.id);
		if (!course) {
			course = { courseId: row.id, courseTitle: row.title, instructors: [] };
			courses.set(row.id, course);
		}
		if (row.display_name !== null) course.instructors.push(row.display_name);
	}
	return [...courses.values()];
}

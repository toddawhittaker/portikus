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

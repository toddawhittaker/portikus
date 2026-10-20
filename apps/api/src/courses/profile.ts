import type { CourseProfile, Role } from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import type { Kysely } from "kysely";

/**
 * The profile a person sees (SPEC.md §8.7): only student memberships decide
 * it, the fullest profile among them wins, and anyone who is not a student,
 * or who studies nowhere, gets the whole interface.
 */
export async function effectiveProfile(
	db: Kysely<Database>,
	user: { id: string; role: Role },
): Promise<CourseProfile> {
	if (user.role !== "student") return "agentic";
	const rows = await db
		.selectFrom("lti_memberships")
		.innerJoin("lti_contexts", "lti_contexts.id", "lti_memberships.context_id")
		.select("lti_contexts.profile")
		.where("lti_memberships.user_id", "=", user.id)
		.where("lti_memberships.role", "=", "student")
		.execute();
	if (rows.length === 0) return "agentic";
	return rows.some((row) => row.profile !== "traditional") ? "agentic" : "traditional";
}

/**
 * Set a course's profile and audit the change in the same transaction
 * (SPEC.md §8.7, §24.11). The caller has already checked who may do this.
 * Returns null when the course does not exist; setting the profile it
 * already has writes no audit row.
 */
export async function setCourseProfile(
	db: Kysely<Database>,
	{
		courseId,
		profile,
		actorUserId,
	}: { courseId: string; profile: CourseProfile; actorUserId: string },
): Promise<{ id: string; profile: CourseProfile } | null> {
	return db.transaction().execute(async (trx) => {
		const before = await trx
			.selectFrom("lti_contexts")
			.select("profile")
			.where("id", "=", courseId)
			.forUpdate()
			.executeTakeFirst();
		if (!before) return null;
		if (before.profile !== profile) {
			await trx
				.updateTable("lti_contexts")
				.set({ profile, updated_at: new Date().toISOString() })
				.where("id", "=", courseId)
				.execute();
			await recordAudit(trx, {
				actor: `user:${actorUserId}`,
				target: courseId,
				action: "course.profile_changed",
				result: "ok",
				metadata: { from: before.profile, to: profile },
			});
		}
		return { id: courseId, profile };
	});
}

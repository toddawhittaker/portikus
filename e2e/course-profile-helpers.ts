/**
 * Courses made straight in the database for the course profile specs
 * (SPEC.md section 8.7). Each call makes a course of its own, so specs that
 * change a profile never disturb the seeded LTI courses.
 */
import { query } from "./helpers";

export type Profile = "agentic" | "traditional";

export async function newCourse(
	profile: Profile,
	title?: string,
): Promise<{ id: string; title: string }> {
	const tag = crypto.randomUUID().slice(0, 8);
	const name = title ?? `Profile ${tag}`;
	const [course] = await query<{ id: string }>(
		`insert into lti_contexts (platform_issuer, context_id, title, platform_name, profile)
		 values ('e2e-profile', $1, $2, 'E2E LMS', $3) returning id`,
		[`profile-${tag}`, name, profile],
	);
	if (!course) throw new Error("could not create the course");
	return { id: course.id, title: name };
}

export async function join(
	courseId: string,
	userId: string,
	role: "student" | "instructor",
) {
	await query(
		`insert into lti_memberships (context_id, user_id, role, last_launch_at)
		 values ($1, $2, $3, now())`,
		[courseId, userId, role],
	);
}

export async function profileOf(courseId: string): Promise<string | undefined> {
	const [row] = await query<{ profile: string }>(
		"select profile from lti_contexts where id = $1",
		[courseId],
	);
	return row?.profile;
}

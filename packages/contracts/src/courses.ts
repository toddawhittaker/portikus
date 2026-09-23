import { z } from "zod";
import { WorkspaceState } from "./workspace.js";

/** A course the caller teaches, from `GET /courses` (docs/EPIC-13.md ruling 23). */
export const CourseSummary = z.object({
	id: z.string().uuid(),
	title: z.string(),
	platformName: z.string().min(1),
});
export type CourseSummary = z.infer<typeof CourseSummary>;

/** Response body for `GET /courses`. */
export const CoursesResponse = z.array(CourseSummary);
export type CoursesResponse = z.infer<typeof CoursesResponse>;

/** A member's role in one course; LTI never grants administrator. */
export const CourseMemberRole = z.enum(["student", "instructor"]);
export type CourseMemberRole = z.infer<typeof CourseMemberRole>;

/** One row of the Course page; never an email, user id, subject or workspace id. */
export const CourseMember = z.object({
	displayName: z.string().min(1),
	role: CourseMemberRole,
	lastLaunchAt: z.string().datetime({ offset: true }),
	workspaceState: WorkspaceState.nullable(),
});
export type CourseMember = z.infer<typeof CourseMember>;

/** Response body for `GET /courses/:courseId/members`, sorted by role then name. */
export const CourseMembersResponse = z.object({
	course: CourseSummary,
	members: z.array(CourseMember),
});
export type CourseMembersResponse = z.infer<typeof CourseMembersResponse>;

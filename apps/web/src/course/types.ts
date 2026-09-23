import { z } from "zod";

// These mirror `packages/contracts/src/courses.ts` as the Epic 13 brief fixes
// it (ruling 23). When that file lands, this module becomes a re-export of it.

export const CourseSummary = z.object({
	id: z.string().uuid(),
	title: z.string(),
	platformName: z.string(),
});
export type CourseSummary = z.infer<typeof CourseSummary>;

export const CourseList = z.array(CourseSummary);

export const CourseMember = z.object({
	displayName: z.string(),
	role: z.enum(["student", "instructor"]),
	lastLaunchAt: z.string(),
	workspaceState: z.string().nullable(),
});
export type CourseMember = z.infer<typeof CourseMember>;

export const CourseMembersResponse = z.object({
	course: CourseSummary,
	members: z.array(CourseMember),
});
export type CourseMembersResponse = z.infer<typeof CourseMembersResponse>;

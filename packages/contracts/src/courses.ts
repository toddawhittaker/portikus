import { z } from "zod";
import { WorkspaceState } from "./workspace.js";

/** A course the caller teaches, from `GET /courses` (ADR 0025). */
export const CourseSummary = z.object({
	id: z.string().uuid(),
	title: z.string(),
	platformName: z.string().min(1),
});
export type CourseSummary = z.infer<typeof CourseSummary>;

/**
 * How much of the interface a course shows its students (ADR 0066). Traditional
 * hides the coding-agent launchers, the Docker controls and the system rows in
 * the Running pane; it never blocks anything.
 */
export const COURSE_PROFILES = ["agentic", "traditional"] as const;
export const CourseProfile = z.enum(COURSE_PROFILES);
export type CourseProfile = z.infer<typeof CourseProfile>;

/** A course in `GET /courses`, with the profile its instructor chose. */
export const CourseListItem = CourseSummary.extend({ profile: CourseProfile });
export type CourseListItem = z.infer<typeof CourseListItem>;

/** Response body for `GET /courses`. */
export const CoursesResponse = z.array(CourseListItem);
export type CoursesResponse = z.infer<typeof CoursesResponse>;

/** A member's role in one course; LTI never grants administrator. */
export const CourseMemberRole = z.enum(["student", "instructor"]);
export type CourseMemberRole = z.infer<typeof CourseMemberRole>;

/**
 * `active` has launched and holds a membership; `not_started` is on the LMS
 * roster but has never launched, so has no account yet (ADR 0058).
 */
export const CourseMemberStatus = z.enum(["active", "not_started"]);
export type CourseMemberStatus = z.infer<typeof CourseMemberStatus>;

/**
 * One row of the Course page; never an email, subject or workspace id. The
 * user id is there so the instructor can remove the member. A roster-only
 * person has no account, so no user id, launch or workspace.
 */
export const ActiveCourseMember = z.object({
	status: z.literal("active"),
	userId: z.string().uuid(),
	displayName: z.string().min(1),
	role: CourseMemberRole,
	lastLaunchAt: z.string().datetime({ offset: true }),
	workspaceState: WorkspaceState.nullable(),
});
export type ActiveCourseMember = z.infer<typeof ActiveCourseMember>;

export const NotStartedCourseMember = z.object({
	status: z.literal("not_started"),
	userId: z.null(),
	displayName: z.string().min(1),
	role: CourseMemberRole,
	lastLaunchAt: z.null(),
	workspaceState: z.null(),
});
export type NotStartedCourseMember = z.infer<typeof NotStartedCourseMember>;

export const CourseMember = z.discriminatedUnion("status", [
	ActiveCourseMember,
	NotStartedCourseMember,
]);
export type CourseMember = z.infer<typeof CourseMember>;

/**
 * How the last roster sync went (ADR 0058). Anything but `ok` applied
 * nothing: `empty` is a roster with no active members, `token_failed` the
 * platform refused the tool's token request, `fetch_failed` a page could not
 * be fetched, `invalid` the roster broke a size or shape limit, and
 * `no_instructor` it would have left no launched instructor in the course.
 */
export const RosterSyncResult = z.enum([
	"ok",
	"empty",
	"token_failed",
	"fetch_failed",
	"invalid",
	"no_instructor",
]);
export type RosterSyncResult = z.infer<typeof RosterSyncResult>;

/**
 * Roster sync state for one course. `available` is false when the platform
 * has no token URL or no launch has given the roster URL yet.
 */
export const CourseRoster = z.object({
	available: z.boolean(),
	syncedAt: z.string().datetime({ offset: true }).nullable(),
	result: RosterSyncResult.nullable(),
});
export type CourseRoster = z.infer<typeof CourseRoster>;

/** Response body for `GET /courses/:courseId/members`, sorted by role then name. */
export const CourseMembersResponse = z.object({
	course: CourseSummary,
	roster: CourseRoster,
	members: z.array(CourseMember),
});
export type CourseMembersResponse = z.infer<typeof CourseMembersResponse>;

const Count = z.number().int().nonnegative();

/**
 * Response body for `POST /courses/:courseId/roster/sync`. The counts are
 * what this run changed; all zero when the result is not `ok`.
 */
export const RosterSyncResponse = z.object({
	roster: CourseRoster,
	/** Memberships matched to an active roster entry. */
	matched: Count,
	/** Roster people with no account yet. */
	notStarted: Count,
	/** Memberships deleted because their subject left the roster. */
	removed: Count,
	/** Memberships whose course role the roster changed. */
	roleChanged: Count,
});
export type RosterSyncResponse = z.infer<typeof RosterSyncResponse>;

/** Request body for `PUT /courses/:courseId/profile` and `PUT /admin/courses/:courseId/profile`. */
export const SetCourseProfileRequest = z.object({ profile: CourseProfile }).strict();
export type SetCourseProfileRequest = z.infer<typeof SetCourseProfileRequest>;

/** Response body of both profile routes: the course as it is now. */
export const CourseProfileResponse = z.object({
	id: z.string().uuid(),
	profile: CourseProfile,
});
export type CourseProfileResponse = z.infer<typeof CourseProfileResponse>;

/** Response body for `GET /admin/courses`: every course on the site, sorted by title. */
export const AdminCoursesResponse = z.array(CourseListItem);
export type AdminCoursesResponse = z.infer<typeof AdminCoursesResponse>;

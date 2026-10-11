import { z } from "zod";
import { CheckDefinition, CheckRun, MAX_CHECKS_PER_PROJECT } from "./checks.js";
import { TreeResponse } from "./files.js";
import { GitDiff, GitStatus } from "./git.js";
import { WorkspaceState } from "./workspace.js";

/**
 * A student's read-only share of one project with the instructors of their
 * courses (SPEC.md §5.2, ADR 0057).
 */

/** How long a share lasts unless the student stops it first. */
export const SHARE_DURATION_HOURS = 24;

/** An open share: started by the student, ending at `endsAt`. */
export const ProjectShare = z.object({
	id: z.string().uuid(),
	startedAt: z.string().datetime({ offset: true }),
	endsAt: z.string().datetime({ offset: true }),
});
export type ProjectShare = z.infer<typeof ProjectShare>;

/** An instructor who opened the share, for the student's viewer list. Name only. */
export const ShareViewer = z.object({
	displayName: z.string().min(1),
	firstViewedAt: z.string().datetime({ offset: true }),
	lastViewedAt: z.string().datetime({ offset: true }),
});
export type ShareViewer = z.infer<typeof ShareViewer>;

/** One course the student belongs to and its instructors' names: who a share reaches. */
export const ShareAudienceCourse = z.object({
	courseId: z.string().uuid(),
	courseTitle: z.string(),
	instructors: z.array(z.string().min(1)),
});
export type ShareAudienceCourse = z.infer<typeof ShareAudienceCourse>;

/**
 * Response body for `GET`, `POST` and `POST …/stop` on
 * `/workspaces/:id/projects/:pid/share`. `share` is null when nothing is
 * open; `viewers` belong to the open share, earliest first; `audience` is
 * everyone who could look, by course title.
 */
export const ProjectShareStatus = z.object({
	share: ProjectShare.nullable(),
	viewers: z.array(ShareViewer),
	audience: z.array(ShareAudienceCourse),
});
export type ProjectShareStatus = z.infer<typeof ProjectShareStatus>;

/** One open share in a course, for its instructors. */
export const CourseShare = z.object({
	projectId: z.string().uuid(),
	projectName: z.string().min(1),
	/** The owner's user id, to put the link on their Course page row. */
	userId: z.string().uuid(),
	displayName: z.string().min(1),
	startedAt: z.string().datetime({ offset: true }),
	endsAt: z.string().datetime({ offset: true }),
	workspaceState: WorkspaceState.nullable(),
});
export type CourseShare = z.infer<typeof CourseShare>;

/** Response body for `GET /courses/:courseId/shares`. */
export const CourseSharesResponse = z.object({
	shares: z.array(CourseShare),
});
export type CourseSharesResponse = z.infer<typeof CourseSharesResponse>;

// The shared reads under `/courses/:courseId/shares/:projectId/` answer in
// the owner's shapes, with secret paths filtered out, except checks, which
// leave out each command. `file` streams the bytes as the owner's file
// route does, so it has no JSON body.

/** `GET …/tree`. */
export const SharedTreeResponse = TreeResponse;
export type SharedTreeResponse = TreeResponse;

/** `GET …/git/status`. */
export const SharedGitStatusResponse = GitStatus;
export type SharedGitStatusResponse = GitStatus;

/** `GET …/git/diff`, HEAD against the working tree only. */
export const SharedGitDiffResponse = GitDiff;
export type SharedGitDiffResponse = GitDiff;

/**
 * One check as an instructor sees it: its name and what its latest run did.
 * Never the command, which may carry a token (SPEC.md §5.2).
 */
export const SharedCheck = CheckDefinition.pick({ id: true, name: true }).extend({
	lastRun: CheckRun.pick({
		state: true,
		startedAt: true,
		endedAt: true,
		exitCode: true,
	}).nullable(),
});
export type SharedCheck = z.infer<typeof SharedCheck>;

/** `GET …/checks`. `error` says why the checks file could not be used, or null. */
export const SharedChecksResponse = z.object({
	checks: z.array(SharedCheck).max(MAX_CHECKS_PER_PROJECT),
	error: z.string().nullable(),
});
export type SharedChecksResponse = z.infer<typeof SharedChecksResponse>;

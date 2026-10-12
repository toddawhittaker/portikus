import { z } from "zod";
import { TerminalId } from "./terminal.js";
import { WorkspaceState } from "./workspace.js";

/**
 * Live help: a student lets one instructor of their course watch, and if the
 * student allows it type into, the terminals of one project (ADR 0063).
 */

/** How long a session lasts unless it ends sooner. */
export const LIVE_HELP_MINUTES = 60;

/** Why a session ended, as the audit records it. An expiry is not audited. */
export const LiveHelpEndReason = z.enum([
	"stopped",
	"helper_left",
	"archived",
	"helper_removed",
]);
export type LiveHelpEndReason = z.infer<typeof LiveHelpEndReason>;

/** An instructor the student may ask for help, with the id the start body needs. */
export const LiveHelpInstructor = z.object({
	userId: z.string().uuid(),
	displayName: z.string().min(1),
});
export type LiveHelpInstructor = z.infer<typeof LiveHelpInstructor>;

/** One of the student's courses and the instructors who teach it. */
export const LiveHelpAudienceCourse = z.object({
	courseId: z.string().uuid(),
	courseTitle: z.string(),
	instructors: z.array(LiveHelpInstructor),
});
export type LiveHelpAudienceCourse = z.infer<typeof LiveHelpAudienceCourse>;

/** The student's view of their open session. */
export const LiveHelpSession = z.object({
	id: z.string().uuid(),
	projectId: z.string().uuid(),
	projectName: z.string().min(1),
	courseId: z.string().uuid(),
	helper: LiveHelpInstructor,
	typing: z.boolean(),
	startedAt: z.string().datetime({ offset: true }),
	endsAt: z.string().datetime({ offset: true }),
});
export type LiveHelpSession = z.infer<typeof LiveHelpSession>;

/**
 * Response body for `GET /workspaces/:id/live-help`, and for the start,
 * typing and stop routes. `session` is null when nothing is open.
 */
export const LiveHelpStatus = z.object({
	session: LiveHelpSession.nullable(),
	audience: z.array(LiveHelpAudienceCourse),
});
export type LiveHelpStatus = z.infer<typeof LiveHelpStatus>;

/** Request body for `POST /workspaces/:id/projects/:pid/live-help`. */
export const StartLiveHelpRequest = z
	.object({
		helperUserId: z.string().uuid(),
		courseId: z.string().uuid(),
	})
	.strict();
export type StartLiveHelpRequest = z.infer<typeof StartLiveHelpRequest>;

/** Request body for `POST /workspaces/:id/live-help/typing`. */
export const LiveHelpTypingRequest = z.object({ typing: z.boolean() }).strict();
export type LiveHelpTypingRequest = z.infer<typeof LiveHelpTypingRequest>;

/** One open session in a course, as its helper sees it. */
export const CourseLiveHelpSession = z.object({
	id: z.string().uuid(),
	projectId: z.string().uuid(),
	projectName: z.string().min(1),
	/** The student's user id and name. */
	userId: z.string().uuid(),
	displayName: z.string().min(1),
	typing: z.boolean(),
	startedAt: z.string().datetime({ offset: true }),
	endsAt: z.string().datetime({ offset: true }),
	workspaceState: WorkspaceState.nullable(),
});
export type CourseLiveHelpSession = z.infer<typeof CourseLiveHelpSession>;

/** Response body for `GET /courses/:courseId/live-help`: the caller's own sessions. */
export const CourseLiveHelpResponse = z.object({
	sessions: z.array(CourseLiveHelpSession),
});
export type CourseLiveHelpResponse = z.infer<typeof CourseLiveHelpResponse>;

/** A terminal of the session's project the helper may attach to. */
export const LiveHelpTerminal = z.object({
	id: TerminalId,
	name: z.string().min(1).max(64),
});
export type LiveHelpTerminal = z.infer<typeof LiveHelpTerminal>;

/** Response body for `GET /courses/:courseId/live-help/:sid`. */
export const CourseLiveHelpDetail = z.object({
	session: CourseLiveHelpSession,
	/** Whether the student has a browser open; attaching is refused when not. */
	studentConnected: z.boolean(),
	terminals: z.array(LiveHelpTerminal),
});
export type CourseLiveHelpDetail = z.infer<typeof CourseLiveHelpDetail>;

/**
 * The server state behind an instructor's live help pages (ADR 0063). There
 * is no events socket for someone else's workspace, so every read polls.
 */
import { CourseLiveHelpDetail, CourseLiveHelpResponse } from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { ApiError, request } from "../../api/request.js";

/** How often the session list and an open session are asked for again. */
export const LIVE_POLL_MS = 5_000;
/** How often a session is asked for while the student is away, to reattach soon after they return. */
const AWAY_POLL_MS = 2_000;

/** Ids that name one live help session. */
export interface LiveRef {
	courseId: string;
	sessionId: string;
}

export const liveBase = ({ courseId, sessionId }: LiveRef) =>
	`/courses/${courseId}/live-help/${sessionId}`;

const keys = {
	list: (courseId: string) => ["courses", courseId, "live-help"] as const,
	detail: (ref: LiveRef) =>
		["courses", ref.courseId, "live-help", ref.sessionId] as const,
};

/** The open sessions students started with the caller in this course. */
export function useLiveSessions(courseId: string) {
	return useQuery({
		queryKey: keys.list(courseId),
		queryFn: () => request(CourseLiveHelpResponse, `/courses/${courseId}/live-help`),
		refetchInterval: LIVE_POLL_MS,
	});
}

/**
 * Whether the student is away: the last read says so, or a socket closed
 * for that reason at `awaySince` and no read since has found them back.
 */
export function studentAway(
	detail: CourseLiveHelpDetail | undefined,
	readAt: number,
	awaySince: number | null,
): boolean {
	if (!detail) return false;
	return !detail.studentConnected || (awaySince !== null && readAt <= awaySince);
}

/**
 * One session: its state, whether the student is there, and the project's
 * terminals. Asked for more often while the student is away.
 */
export function useLiveSession(ref: LiveRef, awaySince: number | null) {
	return useQuery({
		queryKey: keys.detail(ref),
		queryFn: () => request(CourseLiveHelpDetail, liveBase(ref)),
		refetchInterval: (query) => {
			if (sessionGone(query.state.error)) return false;
			return studentAway(query.state.data, query.state.dataUpdatedAt, awaySince)
				? AWAY_POLL_MS
				: LIVE_POLL_MS;
		},
		// A 404 means the session ended; asking again will not change that.
		retry: (count, error) => !sessionGone(error) && count < 2,
	});
}

/** The gate's answer for a session that ended, expired, or was never the caller's. */
export function sessionGone(error: unknown): boolean {
	return error instanceof ApiError && error.status === 404;
}

/** Leaving ends the session for the student too. */
export function useLeaveSession(ref: LiveRef) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: () =>
			request(z.unknown(), `${liveBase(ref)}/leave`, { method: "POST" }),
		onSuccess: () => client.invalidateQueries({ queryKey: keys.list(ref.courseId) }),
	});
}

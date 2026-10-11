import type {
	CourseRoster,
	RosterSyncResponse,
	RosterSyncResult,
} from "@portikus/contracts";
import { Button } from "@portikus/ui";
import * as React from "react";
import { ApiError } from "../api/request.js";
import { useSyncRoster } from "./queries.js";
import { dateTimeText } from "./time.js";

const RESULT_TEXT: Record<RosterSyncResult, string> = {
	ok: "It worked.",
	empty:
		"Your learning system sent a list with no active members, so Portikus changed nothing.",
	token_failed:
		"Your learning system refused Portikus's request for access, so nothing changed. Ask an administrator to check the platform's token URL and keys.",
	fetch_failed:
		"Portikus could not read the member list from your learning system, so nothing changed. Try again in a few minutes.",
	invalid:
		"The member list was larger or shaped differently than Portikus accepts, so nothing changed.",
	no_instructor:
		"The member list would have left this course with no instructor who has opened Portikus from it, so nothing changed. Check the course's instructors in your learning system.",
};

/** Opening the Course page syncs a roster older than this (ADR 0058). */
const ROSTER_REFRESH_MS = 60 * 60 * 1000;

/** Whether opening the page should sync: sync works and the last one is missing or old. */
function rosterIsStale(roster: CourseRoster, now: number): boolean {
	if (!roster.available) return false;
	if (roster.syncedAt === null) return true;
	return now - new Date(roster.syncedAt).getTime() >= ROSTER_REFRESH_MS;
}

/** The counts a sync changed, in plain words. */
function countsText(sync: RosterSyncResponse): string {
	return `${sync.matched} matched, ${sync.notStarted} not started, ${sync.removed} removed, ${sync.roleChanged} role changed.`;
}

/** What the live region says once a sync has run. */
function announcement(sync: RosterSyncResponse): string {
	return sync.roster.result === "ok"
		? `Roster synced: ${countsText(sync)}`
		: `Roster not synced. ${RESULT_TEXT[sync.roster.result ?? "fetch_failed"]}`;
}

/** Whether the roster can be synced, when it last was, how that went, and the Sync roster button. */
export function RosterStatus({
	courseId,
	roster,
}: {
	courseId: string;
	roster: CourseRoster;
}) {
	const sync = useSyncRoster(courseId);
	const failure = sync.error;
	const { mutate } = sync;
	// One automatic sync per visit; the button covers the rest.
	const autoSynced = React.useRef(false);
	React.useEffect(() => {
		if (autoSynced.current || !rosterIsStale(roster, Date.now())) return;
		autoSynced.current = true;
		mutate();
	}, [roster, mutate]);
	return (
		<section
			className="flex flex-col gap-2"
			aria-labelledby="roster-title"
			data-testid="roster-status"
		>
			<h2 className="pk-text-heading m-0" id="roster-title">
				Roster
			</h2>
			{roster.available ? (
				<>
					<p className="pk-text-body m-0">
						{roster.syncedAt ? (
							<>
								{roster.result === "ok" ? "Last synced" : "Last tried"}{" "}
								<time dateTime={roster.syncedAt}>{dateTimeText(roster.syncedAt)}</time>.{" "}
								{roster.result ? RESULT_TEXT[roster.result] : null}
							</>
						) : (
							"Not synced yet."
						)}
					</p>
					<div>
						<Button onClick={() => mutate()} loading={sync.isPending}>
							{sync.isPending ? "Syncing roster…" : "Sync roster"}
						</Button>
					</div>
				</>
			) : (
				<p className="pk-text-body pk-muted m-0" data-testid="roster-unavailable">
					Roster sync is not available for this course. Its learning system gives
					Portikus no token URL, or the course has not sent its member list address yet.
					Only people who open Portikus from the course are listed.
				</p>
			)}
			<p
				className="pk-text-body m-0 empty:-mt-2"
				role="status"
				data-testid="roster-sync"
			>
				{/* Emptied while a sync runs, so the same counts are heard again after it. */}
				{sync.data && !sync.isPending ? announcement(sync.data) : null}
			</p>
			{failure ? (
				<p className="pk-error text-status-error m-0" role="alert">
					{failure instanceof ApiError
						? failure.message
						: "Portikus could not sync the roster. Try again."}
				</p>
			) : null}
		</section>
	);
}

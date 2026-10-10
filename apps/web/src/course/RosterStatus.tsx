import type {
	CourseRoster,
	RosterSyncResponse,
	RosterSyncResult,
} from "@portikus/contracts";
import { Button } from "@portikus/ui";
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
};

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
								Last synced{" "}
								<time dateTime={roster.syncedAt}>{dateTimeText(roster.syncedAt)}</time>.{" "}
								{roster.result ? RESULT_TEXT[roster.result] : null}
							</>
						) : (
							"Not synced yet."
						)}
					</p>
					<div>
						<Button onClick={() => sync.mutate()} disabled={sync.isPending}>
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
				{sync.data ? announcement(sync.data) : null}
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

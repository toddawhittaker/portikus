import type { CourseLiveHelpSession, CourseMember } from "@portikus/contracts";
import { buttonClass, Icon } from "@portikus/ui";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { QuietState } from "../common/QuietState.js";
import { initials } from "../settings/ProfilePane.js";
import { timeAgo } from "../text.js";
import {
	ClassDots,
	ClassDotsKey,
	type DotKind,
	dotCounts,
	plural,
} from "./ClassDots.js";
import { waitingText } from "./memberFilter.js";
import { dateTimeText } from "./time.js";

/** "1 open session", "3 open sessions". */
function sessionsText(count: number): string {
	if (count === 0) return "No open sessions";
	return count === 1 ? "1 open session" : `${count} open sessions`;
}

/**
 * The live help queue as the class's first row: each student waiting for
 * the caller is a tile with their project and wait, and Join opens their
 * session; the longest wait comes first, and every Join is the same
 * outlined button. With no one waiting it is one calm line.
 */
export function LiveHelpCard({
	courseId,
	sessions,
	failed,
}: {
	courseId: string;
	sessions: CourseLiveHelpSession[] | undefined;
	/** The read failed, so there is no queue to show; it says so rather than load for ever. */
	failed: boolean;
}) {
	const queue = sessions
		?.slice()
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	const count = queue?.length;
	const oldest = queue?.[0]?.startedAt ?? null;
	const waiting = count !== undefined && count > 0;
	const now = Date.now();
	return (
		<section
			className="pk-help-queue"
			data-waiting={waiting ? "" : undefined}
			aria-labelledby="course-live-title"
		>
			<div className="pk-help-queue-head">
				<div className="grid min-w-0 flex-1 gap-0.5">
					<h2 className="pk-text-heading m-0" id="course-live-title">
						Live help
					</h2>
					<p className="pk-muted m-0 text-[13px]">
						{failed && count === undefined ? (
							<span data-testid="course-live-error">
								Portikus could not load live help. Reload the page to try again.
							</span>
						) : count === undefined ? (
							"Loading live help sessions…"
						) : (
							<>
								<span className="pk-num">{sessionsText(count)}</span>
								{oldest ? (
									<>
										<span aria-hidden="true"> · </span>
										<span className="sr-only">, </span>
										oldest started{" "}
										<time dateTime={oldest} title={dateTimeText(oldest)}>
											{timeAgo(oldest, now).toLowerCase()}
										</time>
									</>
								) : null}
							</>
						)}
					</p>
				</div>
				<Link
					to="/course/$courseId/live"
					params={{ courseId }}
					className="pk-row-link pk-focus-ring"
					data-testid="course-live-help"
				>
					Open live help
					<Icon name="chevron-right" size="sm" />
				</Link>
			</div>
			{queue && queue.length > 0 ? (
				<ul className="pk-help-tiles">
					{queue.map((session) => (
						<li key={session.id} className="pk-help-tile">
							<span className="pk-initials pk-help-face" aria-hidden="true">
								{initials(session.displayName)}
							</span>
							<span className="grid min-w-0 flex-1 gap-0.5">
								<span className="pk-help-name">{session.displayName}</span>
								<span className="pk-help-meta">
									{session.projectName}
									<span aria-hidden="true"> · </span>
									<span className="sr-only">, </span>
									<span className="pk-help-wait">
										{waitingText(session.startedAt, now)}
									</span>
								</span>
							</span>
							<Link
								to="/course/$courseId/live/$sessionId"
								params={{ courseId, sessionId: session.id }}
								className={buttonClass("secondary")}
							>
								Join
								<span className="sr-only">
									{" "}
									live help with {session.displayName} on {session.projectName}
								</span>
							</Link>
						</li>
					))}
				</ul>
			) : count === 0 ? (
				<QuietState
					title="No one is waiting for you"
					detail="A request shows here the moment a student asks you for live help."
				/>
			) : null}
		</section>
	);
}

/** The counts that need someone stand out in the sentence, as their dots do. */
const COUNT_TONE: Partial<Record<DotKind, "warning" | "error">> = {
	waiting: "warning",
	error: "error",
};

/**
 * The class in one line: how many students, then each kind of dot with its
 * count, with a dot per student. Every figure counts students only, as the
 * Members filters do; instructors have a filter of their own.
 */
export function MemberCounts({
	members,
	waiting,
}: {
	members: CourseMember[];
	waiting: ReadonlySet<string>;
}) {
	const students = members.filter((member) => member.role === "student");
	// Grouped exactly as the dots are, so the words say what the dots show.
	const parts = dotCounts(students, waiting);
	return (
		<section
			className="pk-class-summary"
			data-testid="course-counts"
			aria-labelledby="class-now-title"
		>
			<h2 className="pk-overline" id="class-now-title">
				Class now
			</h2>
			<p className="pk-class-sentence">
				<strong className="pk-num">
					{plural(students.length, "student", "students")}
				</strong>
				{parts.map((part) => (
					<React.Fragment key={part.kind}>
						<span className="pk-class-sep" aria-hidden="true">
							·
						</span>
						<span className="sr-only">, </span>
						<span className="pk-num" data-tone={COUNT_TONE[part.kind]}>
							{part.text}
						</span>
					</React.Fragment>
				))}
			</p>
			<div className="pk-class-picture">
				<ClassDots students={students} waiting={waiting} />
				<ClassDotsKey students={students} waiting={waiting} />
			</div>
		</section>
	);
}

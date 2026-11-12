import { Icon, PageIntro, StateBadge } from "@portikus/ui";
import { Link, useParams } from "@tanstack/react-router";
import { useRef, useState, useSyncExternalStore } from "react";
import { ApiError } from "../../api/request.js";
import { QuietState } from "../../common/QuietState.js";
import { usePageTitle } from "../../pageTitle.js";
import { timeAgo } from "../../text.js";
import { CourseFrame } from "../CourseFrame.js";
import "../course.css";
import { initials } from "../../settings/ProfilePane.js";
import { dateTimeText } from "../time.js";
import { useFocusHeadingOnArrival } from "./arrival.js";
import { modeText } from "./mode.js";
import { useLiveSessions } from "./queries.js";

/** Below this container width the Mode and Ends columns fold under the student's name. */
const WIDE_ONLY = "@max-2xl:hidden";
const NARROW_ONLY = "hidden @max-2xl:block";

/** course.css repeats 64rem, since a media query cannot read a variable. */
const WIDE_QUERY = "(width >= 64rem)";

function subscribeWide(onChange: () => void): () => void {
	if (typeof window.matchMedia !== "function") return () => {};
	const query = window.matchMedia(WIDE_QUERY);
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}

/** True while the window is wide enough to show the chosen request beside the queue. */
function useWideLayout(): boolean {
	return useSyncExternalStore(
		subscribeWide,
		() =>
			typeof window.matchMedia === "function" && window.matchMedia(WIDE_QUERY).matches,
	);
}

/** `/course/:courseId/live`: the live help sessions students opened with the caller (ADR 0063). */
export function LiveHelpPage() {
	return (
		<CourseFrame testId="page-live-help" labelledBy="live-title">
			<LiveHelpList />
		</CourseFrame>
	);
}

function LiveHelpList() {
	const { courseId } = useParams({ from: "/course/$courseId/live" });
	const sessions = useLiveSessions(courseId);
	// The student who has waited longest comes first.
	const list = sessions.data?.sessions
		.slice()
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	const now = Date.now();
	const notFound = sessions.error instanceof ApiError && sessions.error.status === 404;
	usePageTitle("Live help");
	const heading = useRef<HTMLHeadingElement>(null);
	useFocusHeadingOnArrival(heading);
	const wide = useWideLayout();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	// The chosen request, or the longest wait when none is chosen or it closed.
	const selected = list?.find((session) => session.id === selectedId) ?? list?.[0];

	return (
		<>
			<div className="pk-admin-head">
				{/* One way back, in the eyebrow's place over the title. */}
				<Link
					to="/course/$courseId"
					params={{ courseId }}
					className="pk-eyebrow pk-back-link pk-focus-ring"
				>
					<Icon name="arrow-left" size="sm" />
					Back to the course
				</Link>
				<h1
					className="pk-text-display pk-admin-title"
					id="live-title"
					ref={heading}
					tabIndex={-1}
				>
					Live help
				</h1>
				<PageIntro
					id="live-help"
					summary="About Live help"
					lead="Students waiting for you, the longest wait first."
					helpHref="/help#instructor-live-help"
				>
					Students who asked you for help in this course. A session shows you the
					student's terminals in one project as they work. You can type only when the
					student lets you.
				</PageIntro>
			</div>
			{/* One live region under the heading, so the loading text is heard changing. */}
			<p className="pk-text-body pk-muted mt-4" role="status">
				{sessions.isError ? (
					<span data-testid="live-error">
						{notFound
							? "This course was not found, or you are not an instructor in it."
							: "Portikus could not load your live help sessions. Reload the page to try again."}
					</span>
				) : !list ? (
					"Loading live help sessions…"
				) : list.length === 0 ? (
					<span data-testid="live-empty">
						No student has asked you for live help in this course. A session appears
						here when a student starts one and names you.
					</span>
				) : null}
			</p>
			{list && list.length > 0 ? (
				<div className="pk-live mt-4">
					<div className="grid min-w-0 gap-3">
						<div className="pk-table-wrap pk-live-wrap @container overflow-clip">
							<table
								className="pk-table pk-table--page pk-live-table"
								data-testid="live-sessions"
							>
								<caption className="sr-only">Open live help sessions</caption>
								<thead>
									<tr>
										<th scope="col">Student</th>
										<th scope="col">Project</th>
										<th scope="col">Waiting</th>
										<th scope="col" className={WIDE_ONLY}>
											Mode
										</th>
										<th scope="col">Workspace</th>
										<th scope="col" className="pk-cell-actions">
											<span className="sr-only">Actions</span>
										</th>
									</tr>
								</thead>
								<tbody>
									{list.map((session) => {
										const chosen = wide && session.id === selected?.id;
										const name = (
											<span id={`live-name-${session.id}`}>{session.displayName}</span>
										);
										return (
											<tr key={session.id} data-selected={chosen ? "" : undefined}>
												<th
													scope="row"
													className="pk-live-name whitespace-normal py-2 font-semibold [overflow-wrap:anywhere]"
													aria-labelledby={`live-name-${session.id}`}
												>
													{wide ? (
														<button
															type="button"
															className="pk-live-pick pk-focus-ring"
															aria-pressed={chosen}
															onClick={() => setSelectedId(session.id)}
														>
															{name}
														</button>
													) : (
														name
													)}
													<span
														className={`${NARROW_ONLY} pk-cell-muted text-[12px] font-normal`}
													>
														{modeText(session.typing)}
														<span aria-hidden="true"> · </span>
														<span className="sr-only">, </span>
														Ends{" "}
														<time className="pk-num" dateTime={session.endsAt}>
															{dateTimeText(session.endsAt)}
														</time>
													</span>
												</th>
												<td className="pk-live-project whitespace-normal [overflow-wrap:anywhere]">
													{session.projectName}
												</td>
												<td className="pk-live-started whitespace-nowrap">
													<time
														dateTime={session.startedAt}
														title={dateTimeText(session.startedAt)}
													>
														{timeAgo(session.startedAt, now)}
													</time>
												</td>
												<td className={`${WIDE_ONLY} pk-live-mode`}>
													<span className="pk-tag">{modeText(session.typing)}</span>
												</td>
												<td className="pk-live-state">
													{session.workspaceState ? (
														<StateBadge
															state={session.workspaceState}
															statusRole={false}
															plain={session.workspaceState !== "error"}
														/>
													) : (
														<span className="pk-cell-muted">No workspace</span>
													)}
												</td>
												<td className="pk-cell-actions pk-live-action">
													<Link
														to="/course/$courseId/live/$sessionId"
														params={{ courseId, sessionId: session.id }}
														className="pk-btn pk-focus-ring inline-flex h-[var(--size-control-sm)] items-center rounded-sm border border-line-strong bg-surface-raised px-3 font-semibold text-ink hover:bg-surface-hover"
													>
														Open
														<span className="sr-only">
															{" "}
															live help with {session.displayName} on{" "}
															{session.projectName}
														</span>
													</Link>
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
						<QuietState
							testId="live-queue-calm"
							title="No one else is waiting"
							detail="New requests appear here as students ask."
						/>
					</div>
					{wide && selected ? (
						<section
							className="pk-card pk-live-detail"
							aria-labelledby="live-detail-title"
							data-testid="live-detail"
						>
							<div className="pk-live-who">
								<span className="pk-initials pk-live-face" aria-hidden="true">
									{initials(selected.displayName)}
								</span>
								<div className="grid min-w-0 gap-0.5">
									<p className="pk-group-label">
										{selected.id === list[0]?.id ? "Next waiting" : "Selected request"}
									</p>
									<h2
										className="pk-text-heading m-0 [overflow-wrap:anywhere]"
										id="live-detail-title"
									>
										{selected.displayName}
									</h2>
								</div>
							</div>
							<dl>
								<dt>Project</dt>
								<dd>{selected.projectName}</dd>
								<dt>Waiting since</dt>
								<dd className="pk-num">
									<time dateTime={selected.startedAt}>
										{dateTimeText(selected.startedAt)}
									</time>{" "}
									<span className="pk-muted">
										({timeAgo(selected.startedAt, now).toLowerCase()})
									</span>
								</dd>
								<dt>Mode</dt>
								<dd>{modeText(selected.typing)}</dd>
								<dt>Ends</dt>
								<dd className="pk-num">
									<time dateTime={selected.endsAt}>
										{dateTimeText(selected.endsAt)}
									</time>
								</dd>
								<dt>Workspace</dt>
								<dd>
									{selected.workspaceState ? (
										<StateBadge state={selected.workspaceState} statusRole={false} />
									) : (
										"No workspace"
									)}
								</dd>
							</dl>
							<Link
								to="/course/$courseId/live/$sessionId"
								params={{ courseId, sessionId: selected.id }}
								className="pk-live-open pk-btn pk-focus-ring inline-flex h-[var(--size-control-md)] items-center justify-center gap-1.5 rounded-sm border border-transparent bg-accent-fill px-4 font-semibold text-on-accent-fill hover:bg-accent-fill-hover"
							>
								Join session
								<span className="sr-only">
									{" "}
									with {selected.displayName} on {selected.projectName}
								</span>
							</Link>
							<p className="pk-text-caption pk-muted m-0">
								You see their terminals as they work. You can type only when they let
								you.
							</p>
						</section>
					) : null}
				</div>
			) : null}
		</>
	);
}

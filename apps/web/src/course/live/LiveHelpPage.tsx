import { PageIntro, StateBadge } from "@portikus/ui";
import { Link, useParams } from "@tanstack/react-router";
import { ApiError } from "../../api/request.js";
import { usePageTitle } from "../../pageTitle.js";
import { CourseFrame } from "../CourseFrame.js";
import { dateTimeText } from "../time.js";
import { modeText } from "./mode.js";
import { useLiveSessions } from "./queries.js";

/** Below this container width the Mode and Ends columns fold under the student's name. */
const WIDE_ONLY = "@max-2xl:hidden";
const NARROW_ONLY = "hidden @max-2xl:block";

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
	const list = sessions.data?.sessions;
	const notFound = sessions.error instanceof ApiError && sessions.error.status === 404;
	usePageTitle("Live help");

	return (
		<>
			<Link
				to="/course/$courseId"
				params={{ courseId }}
				className="pk-focus-ring rounded-sm text-[13px] text-accent-text"
			>
				Back to the course
			</Link>
			<h1 className="pk-text-title mt-2" id="live-title">
				Live help
			</h1>
			<div className="mt-4">
				<PageIntro
					id="live-help"
					summary="About Live help"
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
				<div className="pk-table-wrap @container mt-4 overflow-clip">
					<table className="pk-table pk-table--page" data-testid="live-sessions">
						<caption className="sr-only">Open live help sessions</caption>
						<thead>
							<tr>
								<th scope="col">Student</th>
								<th scope="col">Project</th>
								<th scope="col" className={WIDE_ONLY}>
									Mode
								</th>
								<th scope="col" className={WIDE_ONLY}>
									Ends
								</th>
								<th scope="col">Workspace</th>
								<th scope="col" className="pk-cell-actions">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{list.map((session) => (
								<tr key={session.id}>
									<th
										scope="row"
										className="whitespace-normal py-2 font-semibold [overflow-wrap:anywhere]"
										aria-labelledby={`live-name-${session.id}`}
									>
										<span id={`live-name-${session.id}`}>{session.displayName}</span>
										<span
											className={`${NARROW_ONLY} pk-cell-muted text-[12px] font-normal`}
										>
											{modeText(session.typing)}
											<span aria-hidden="true"> · </span>
											<span className="sr-only">, </span>
											Ends{" "}
											<time dateTime={session.endsAt}>
												{dateTimeText(session.endsAt)}
											</time>
										</span>
									</th>
									<td className="whitespace-normal [overflow-wrap:anywhere]">
										{session.projectName}
									</td>
									<td className={WIDE_ONLY}>{modeText(session.typing)}</td>
									<td className={WIDE_ONLY}>
										<time dateTime={session.endsAt}>
											{dateTimeText(session.endsAt)}
										</time>
									</td>
									<td>
										{session.workspaceState ? (
											<StateBadge state={session.workspaceState} statusRole={false} />
										) : (
											<span className="pk-cell-muted">No workspace</span>
										)}
									</td>
									<td className="pk-cell-actions">
										<Link
											to="/course/$courseId/live/$sessionId"
											params={{ courseId, sessionId: session.id }}
											className="pk-focus-ring rounded-sm font-semibold text-accent-text"
										>
											Open
											<span className="sr-only">
												{" "}
												live help with {session.displayName} on {session.projectName}
											</span>
										</Link>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}
		</>
	);
}

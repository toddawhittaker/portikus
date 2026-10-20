import type { CourseLiveHelpDetail } from "@portikus/contracts";
import { Button, EmptyState, Icon, useToast } from "@portikus/ui";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { usePageTitle } from "../../pageTitle.js";
import { CourseFrame } from "../CourseFrame.js";
import { dateTimeText } from "../time.js";
import { focusHeadingOnArrival } from "./arrival.js";
import { HelperTerminal } from "./HelperTerminal.js";
import type { HelperCloseAction } from "./helperClose.js";
import { modeText } from "./mode.js";
import { openLivePreview, useLiveListening } from "./previews.js";
import {
	type LiveRef,
	liveBase,
	sessionGone,
	studentAway,
	useLeaveSession,
	useLiveSession,
} from "./queries.js";

/**
 * `/course/:courseId/live/:sessionId`: one live help session as its
 * instructor sees it (ADR 0063). The student's terminals in one project,
 * read only unless the student lets the instructor type, and the previews
 * of what the workspace is serving.
 */
export function LiveSessionPage() {
	return (
		<CourseFrame testId="page-live-session" labelledBy="live-session-title" fill>
			<LiveSession />
		</CourseFrame>
	);
}

function LiveSession() {
	const { courseId, sessionId } = useParams({
		from: "/course/$courseId/live/$sessionId",
	});
	const ref: LiveRef = { courseId, sessionId };
	const navigate = useNavigate();
	// When a socket last closed for the student being away, or the session ending.
	const [awayAt, setAwayAt] = useState<number | null>(null);
	const [endedByClose, setEndedByClose] = useState(false);
	// Bumped to open every socket again, as after a mode change.
	const [attach, setAttach] = useState(0);
	const [leaveFailed, setLeaveFailed] = useState(false);

	const detail = useLiveSession(ref, awayAt);
	const data = detail.data;
	const ended = endedByClose || sessionGone(detail.error);
	const away = !ended && studentAway(data, detail.dataUpdatedAt, awayAt);
	const live = !ended && !away && data !== undefined;
	const leave = useLeaveSession(ref);
	usePageTitle(data ? `Live help with ${data.session.displayName}` : "Live help");

	const heading = useRef<HTMLHeadingElement>(null);
	// The terminal leaves the page when the session ends or the student goes;
	// focus that fell to the page goes to the heading instead.
	useEffect(() => {
		if (!ended && !away) return;
		const active = document.activeElement;
		if (active === null || active === document.body) heading.current?.focus();
	}, [ended, away]);

	function onClosed(action: HelperCloseAction) {
		if (action === "ended") setEndedByClose(true);
		else if (action === "away") setAwayAt(Date.now());
		else {
			// The typing flag changed before the close, so the next read has the new
			// mode, and a new mode opens the socket by itself. Bump only when it did not.
			const before = data?.session.typing;
			void detail.refetch().then((read) => {
				if (read.data?.session.typing === before) setAttach((count) => count + 1);
			});
		}
	}

	async function onLeave() {
		if (leave.isPending) return;
		setLeaveFailed(false);
		try {
			await leave.mutateAsync();
			focusHeadingOnArrival();
			await navigate({ to: "/course/$courseId/live", params: { courseId } });
		} catch {
			setLeaveFailed(true);
		}
	}

	return (
		<>
			<Link
				to="/course/$courseId/live"
				params={{ courseId }}
				className="pk-focus-ring self-start rounded-sm text-[13px] text-accent-text"
			>
				All live help sessions
			</Link>
			<h1
				className="pk-text-title mt-2 [overflow-wrap:anywhere]"
				id="live-session-title"
				ref={heading}
				tabIndex={-1}
			>
				{data ? `Live help with ${data.session.displayName}` : "Live help"}
			</h1>
			{data && !ended ? (
				<p className="pk-muted mt-1 text-[13px] [overflow-wrap:anywhere]">
					Project {data.session.projectName}. Ends at{" "}
					<time dateTime={data.session.endsAt}>
						{dateTimeText(data.session.endsAt)}
					</time>{" "}
					unless the student ends it sooner.
				</p>
			) : null}
			{/* Always mounted, so leaving, ending and the student going are heard. */}
			<p className="sr-only" role="status" data-testid="live-session-status">
				{statusText({ ended, away, leaveFailed })}
			</p>
			{ended ? (
				<Ended courseId={courseId} />
			) : detail.isError ? (
				<p className="pk-text-body mt-6" data-testid="live-session-error">
					Portikus could not load this session. Reload the page to try again.
				</p>
			) : !data ? (
				<p className="pk-text-body pk-muted mt-6">Loading this session…</p>
			) : (
				<>
					<div className="mt-4 flex flex-wrap items-center gap-3">
						<ModeIndicator typing={data.session.typing} />
						<Button
							variant="danger"
							onClick={() => void onLeave()}
							aria-disabled={leave.isPending || undefined}
							data-testid="live-leave"
						>
							{leave.isPending ? "Leaving…" : "Leave session"}
						</Button>
						<p className="pk-muted m-0 text-[13px]">
							{leaveFailed
								? "Portikus could not end the session. Try again."
								: "Leaving ends the session for the student too."}
						</p>
					</div>
					{/* The terminal fills the window's height left below this point, as the
					    workspace's does, so clicking into it never scrolls the heading away. */}
					<div className="@container mt-6 flex flex-1 flex-col">
						<div className="flex flex-1 flex-col gap-6 @5xl:flex-row">
							<TerminalsSection
								liveRef={ref}
								detail={data}
								away={away}
								live={live}
								attach={attach}
								onClosed={onClosed}
								onDropped={() => void detail.refetch()}
								onRetry={() => setAttach((count) => count + 1)}
							/>
							<Previews liveRef={ref} enabled={live} />
						</div>
					</div>
				</>
			)}
		</>
	);
}

function statusText(state: { ended: boolean; away: boolean; leaveFailed: boolean }) {
	if (state.ended) return "This live help session has ended.";
	if (state.away) return "The student is away.";
	if (state.leaveFailed) return "Portikus could not end the session. Try again.";
	return "";
}

/** The student's terminals in the project, one shown at a time. */
function TerminalsSection({
	liveRef,
	detail,
	away,
	live,
	attach,
	onClosed,
	onDropped,
	onRetry,
}: {
	liveRef: LiveRef;
	detail: CourseLiveHelpDetail;
	away: boolean;
	/** The session is open and the student is there, so a socket may open. */
	live: boolean;
	/** Changes to open the socket again. */
	attach: number;
	onClosed: (action: HelperCloseAction) => void;
	onDropped: () => void;
	onRetry: () => void;
}) {
	const [chosen, setChosen] = useState<string | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const terminals = detail.terminals;
	const shown = terminals.find((terminal) => terminal.id === chosen) ?? terminals[0];
	// Only a terminal takes the height left; a message keeps its own.
	const showing = shown !== undefined && live;

	return (
		<section
			aria-labelledby="live-terminals-title"
			className={`flex min-w-0 flex-col @5xl:flex-1 ${showing ? "flex-1" : ""}`}
		>
			<h2
				className="pk-text-heading mb-2"
				id="live-terminals-title"
				ref={heading}
				tabIndex={-1}
			>
				Terminals
			</h2>
			{away ? (
				<div data-testid="live-away">
					<EmptyState icon="info" title="The student is away">
						Their workspace is not open in any browser, or it stopped. Their terminal
						comes back here when they return.
					</EmptyState>
				</div>
			) : terminals.length === 0 ? (
				<p className="pk-text-body pk-muted" data-testid="live-no-terminals">
					The student has no terminals open in {detail.session.projectName}. One appears
					here when they open it.
				</p>
			) : (
				<div className="flex min-w-0 flex-1 flex-col gap-3">
					<ul className="flex flex-wrap gap-2" aria-label="Choose a terminal">
						{terminals.map((terminal) => (
							<li key={terminal.id} className="min-w-0">
								<Button
									size="sm"
									variant={terminal.id === shown?.id ? "primary" : "secondary"}
									aria-pressed={terminal.id === shown?.id}
									onClick={() => setChosen(terminal.id)}
									className="max-w-full truncate"
								>
									{terminal.name}
								</Button>
							</li>
						))}
					</ul>
					{showing ? (
						<HelperTerminal
							key={shown.id}
							path={`${liveBase(liveRef)}/terminals/${shown.id}/ws`}
							name={shown.name}
							typing={detail.session.typing}
							attach={attach}
							onClosed={onClosed}
							onDropped={onDropped}
							onRetry={onRetry}
							onLeave={() => heading.current?.focus()}
						/>
					) : null}
				</div>
			)}
		</section>
	);
}

/** Says plainly whether what the instructor types reaches the student's shell. */
function ModeIndicator({ typing }: { typing: boolean }) {
	return (
		<p
			className={
				typing
					? "m-0 flex min-w-0 items-center gap-2 rounded-sm bg-status-warning-soft px-3 py-2 text-status-warning"
					: "m-0 flex min-w-0 items-center gap-2 rounded-sm border border-line-strong px-3 py-2"
			}
			role="status"
			data-testid="live-mode"
			data-mode={typing ? "type" : "view"}
		>
			<Icon name={typing ? "terminal" : "lock"} size="md" />
			<span>
				<strong>{modeText(typing)}.</strong>{" "}
				{typing
					? "What you type runs in the student's shell, as the student."
					: "What you type is not sent. The student can let you type."}
			</span>
		</p>
	);
}

function Ended({ courseId }: { courseId: string }) {
	return (
		<section
			className="mt-6 flex flex-col gap-2"
			data-testid="live-ended"
			aria-labelledby="live-ended-title"
		>
			<h2 className="pk-text-heading m-0" id="live-ended-title">
				This session has ended
			</h2>
			<p className="pk-text-body pk-muted m-0">
				The student ended it, you left, or its hour ran out. You no longer see their
				terminals or previews.
			</p>
			<p className="m-0">
				<Link
					to="/course/$courseId/live"
					params={{ courseId }}
					className="pk-focus-ring rounded-sm font-semibold text-accent-text"
				>
					See your other live help sessions
				</Link>
			</p>
		</section>
	);
}

function Previews({ liveRef, enabled }: { liveRef: LiveRef; enabled: boolean }) {
	const listening = useLiveListening(liveRef, enabled);
	const toast = useToast();
	const services = listening.data;

	async function open(port: number) {
		const opened = await openLivePreview(liveRef, port);
		if (!opened) {
			toast.show({
				title: `Portikus could not open the preview of port ${port}. Check that it is still running, then try again.`,
			});
		}
	}

	return (
		<section
			aria-labelledby="live-previews-title"
			className="min-w-0 shrink-0 @5xl:w-72"
		>
			<h2 className="pk-text-heading mb-2" id="live-previews-title">
				Previews
			</h2>
			{!enabled ? (
				<p className="pk-text-body pk-muted m-0">
					Previews show here while the student's workspace is open.
				</p>
			) : listening.isError ? (
				<p className="pk-text-body m-0">
					Portikus could not load the student's previews. They are asked for again in a
					few seconds.
				</p>
			) : !services ? (
				<p className="pk-text-body pk-muted m-0">Loading previews…</p>
			) : services.length === 0 ? (
				<p className="pk-text-body pk-muted m-0" data-testid="live-no-previews">
					Nothing in the student's workspace is listening on a port.
				</p>
			) : (
				<ul className="flex flex-col divide-y divide-line" data-testid="live-previews">
					{services.map((service) => (
						<li key={service.port} className="flex min-w-0 items-center gap-3 py-2">
							<span className="pk-mono-body min-w-0 flex-1">Port {service.port}</span>
							{/* aria-label, because Chromium names a hidden span with a space before it. */}
							<Button
								size="sm"
								aria-label={`Open in new tab, port ${service.port}`}
								onClick={() => void open(service.port)}
							>
								<Icon name="external" size="sm" />
								Open in new tab
							</Button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

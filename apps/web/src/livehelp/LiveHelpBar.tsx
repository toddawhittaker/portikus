import type { LiveHelpSession } from "@portikus/contracts";
import { Button, Icon } from "@portikus/ui";
import { type RefObject, useEffect, useRef, useState } from "react";
import { ApiError, errorText } from "../api/request.js";
import { useFocusFallback } from "../shell/useFocusFallback.js";
import { timeLeft } from "../text.js";
import {
	type LiveHelpEnded,
	useLiveHelpStatus,
	useLiveHelpTyping,
	useStopLiveHelp,
} from "./queries.js";

/** A poll can land a few seconds after the limit, and that end is still the limit. */
const EXPIRY_SLACK_MS = 10_000;

/** What the helper sees: previews cover the whole workspace, not one project (ADR 0063). */
function seesWhat(projectName: string): string {
	return `the terminals of ${projectName} and previews of anything running in your workspace`;
}

/** Why `before` ended, from the reason the API kept, or from the time when it has none. */
function endedText(
	before: LiveHelpSession,
	ended: LiveHelpEnded | null,
	endedHere: boolean,
	now: number,
): string {
	const name = before.helper.displayName;
	if (endedHere) return `You ended live help with ${name}.`;
	switch (ended?.sessionId === before.id ? ended.reason : null) {
		case "stopped":
			return `You ended live help with ${name} in another tab or browser.`;
		case "helper_left":
			return `Live help with ${name} ended because they left.`;
		case "archived":
			return `Live help with ${name} ended because ${before.projectName} was archived.`;
		case "helper_removed":
			return `Live help with ${name} ended because they no longer teach your course.`;
		case "expired":
			return `Live help with ${name} ended because its time ran out.`;
	}
	// A background tab can poll after the API stopped keeping the reason.
	if (now + EXPIRY_SLACK_MS >= Date.parse(before.endsAt)) {
		return `Live help with ${name} ended because its time ran out.`;
	}
	return `Live help with ${name} ended.`;
}

/**
 * What changed between two reads of the session, for the status region; null
 * when nothing worth saying did. `ended` is the API's record of the session
 * that ended last; `endedHere` is true after this page's End.
 */
export function liveHelpChange(
	before: LiveHelpSession | null,
	after: LiveHelpSession | null,
	ended: LiveHelpEnded | null,
	endedHere: boolean,
	now: number,
): string | null {
	if (after && before?.id !== after.id) {
		return `Live help started. ${after.helper.displayName} can see ${seesWhat(after.projectName)}. ${after.typing ? "Typing is on." : "Typing is off."}`;
	}
	if (before && !after) return endedText(before, ended, endedHere, now);
	if (before && after && before.typing !== after.typing) {
		return after.typing
			? `${after.helper.displayName} can now type in your terminals.`
			: `${after.helper.displayName} can no longer type. They can only watch.`;
	}
	return null;
}

/**
 * Across the top of the workspace while live help is open (ADR 0063). It
 * cannot be dismissed: the student always sees who is watching, whether they
 * may type, and how to end it. The status region stays mounted so starts,
 * typing changes and ends are announced.
 */
export function LiveHelpBar({
	workspaceId,
	fallbackFocus,
}: {
	workspaceId: string;
	/** Takes focus when the bar goes away while holding it, as after End. */
	fallbackFocus?: RefObject<HTMLElement | null>;
}) {
	const status = useLiveHelpStatus(workspaceId);
	const typing = useLiveHelpTyping(workspaceId);
	const stop = useStopLiveHelp(workspaceId);
	const session = status.data?.session ?? null;
	const lastEnded = status.data?.lastEnded ?? null;
	const [announcement, setAnnouncement] = useState("");
	const endedHere = useRef(false);
	// Undefined until the first read, so a session already open on load is not announced.
	const previous = useRef<LiveHelpSession | null | undefined>(undefined);
	const now = useNow(session !== null);

	useEffect(() => {
		if (!status.isSuccess) return;
		const before = previous.current;
		previous.current = session;
		if (before === undefined) return;
		const change = liveHelpChange(
			before,
			session,
			lastEnded,
			endedHere.current,
			Date.now(),
		);
		if (change) setAnnouncement(change);
		if (!session) endedHere.current = false;
	}, [session, lastEnded, status.isSuccess]);

	// A refused toggle means the session ended meanwhile; the next read says so.
	const failure = [typing.error, stop.error].find(
		(error) => error && !(error instanceof ApiError && error.status === 404),
	);

	return (
		<>
			<p
				role="status"
				aria-live="polite"
				className="sr-only"
				data-testid="live-help-announce"
			>
				{announcement}
			</p>
			{session ? (
				<OpenBar
					session={session}
					now={now}
					failure={failure}
					typingBusy={typing.isPending}
					stopBusy={stop.isPending}
					onTyping={() => typing.mutate(!session.typing)}
					onEnd={() => {
						endedHere.current = true;
						stop.mutate(undefined, {
							onError: () => {
								endedHere.current = false;
							},
						});
					}}
					fallbackFocus={fallbackFocus}
				/>
			) : null}
		</>
	);
}

function OpenBar({
	session,
	now,
	failure,
	typingBusy,
	stopBusy,
	onTyping,
	onEnd,
	fallbackFocus,
}: {
	session: LiveHelpSession;
	now: number;
	failure: unknown;
	typingBusy: boolean;
	stopBusy: boolean;
	onTyping: () => void;
	onEnd: () => void;
	fallbackFocus?: RefObject<HTMLElement | null>;
}) {
	const ref = useFocusFallback<HTMLElement>(fallbackFocus);
	return (
		<section
			ref={ref}
			className={`pk-livehelp${session.typing ? " is-typing" : ""}`}
			aria-labelledby="live-help-title"
			data-testid="live-help-bar"
		>
			<div className="pk-livehelp-main">
				<h2 className="pk-livehelp-title" id="live-help-title">
					<span className="pk-livehelp-icon">
						<Icon name="users" size="md" />
					</span>
					Live help with {session.helper.displayName}
				</h2>
				<p className="pk-livehelp-body" data-testid="live-help-summary">
					They can see {seesWhat(session.projectName)}.{" "}
					{session.typing
						? "They can type in them, with a full shell as you."
						: "They cannot type."}
				</p>
				{failure ? (
					<p className="pk-livehelp-body" role="alert" data-testid="live-help-error">
						{errorText(failure)}
					</p>
				) : null}
			</div>
			<div className="pk-livehelp-actions">
				<span className="pk-livehelp-time" data-testid="live-help-time">
					{timeLeft(session.endsAt, now)}
				</span>
				<Button
					size="sm"
					data-testid="live-help-typing"
					loading={typingBusy}
					onClick={onTyping}
				>
					{session.typing ? "Stop typing" : "Let them type"}
				</Button>
				<Button
					size="sm"
					variant="danger"
					data-testid="live-help-end"
					loading={stopBusy}
					onClick={onEnd}
				>
					End live help
				</Button>
			</div>
		</section>
	);
}

/** The time, refreshed every 30 seconds while `ticking`; the time left is never announced. */
function useNow(ticking: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!ticking) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, [ticking]);
	return now;
}

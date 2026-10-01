import { Button } from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import { LINK_CHANNEL, type LinkMessage } from "../link/channel.js";
import { startLink, useMyLinks, useUnlink } from "./profileQueries.js";

/**
 * A course account links itself to an SSO account; an SSO account lists and
 * unlinks its course sign-ins (docs/archive/epics/EPIC-13-1.md, "The flow" steps 1, 2 and 7).
 */
export function LinkedAccounts() {
	const links = useMyLinks();
	const unlink = useUnlink();
	const [waiting, setWaiting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const startButton = useRef<HTMLButtonElement>(null);
	const reopenButton = useRef<HTMLButtonElement>(null);

	// The link finishes in its own tab; the app root reloads on "linked" (useLinkedReload).
	useEffect(() => {
		const channel = new BroadcastChannel(LINK_CHANNEL);
		channel.onmessage = (event: MessageEvent<LinkMessage>) => {
			if (event.data?.type === "cancelled") setWaiting(false);
		};
		return () => channel.close();
	}, []);

	// Keep focus on a control when the button under it is swapped out.
	const wasWaiting = useRef(false);
	useEffect(() => {
		if (waiting) reopenButton.current?.focus();
		else if (wasWaiting.current) startButton.current?.focus();
		wasWaiting.current = waiting;
	}, [waiting]);

	function openLinkTab() {
		// Opened synchronously in the click so it is not blocked; opener is cut by hand
		// because "noopener" would hide whether a pop-up blocker stopped it.
		const tab = window.open("", "_blank");
		if (tab === null) {
			location.assign("/link/start");
			return;
		}
		tab.opener = null;
		setStartError(null);
		setWaiting(true);
		// The start is posted from this tab, where the click happened (security review of #515).
		startLink().then(
			({ redirectUrl }) => {
				tab.location.href = redirectUrl;
			},
			(failure: unknown) => {
				tab.close();
				setWaiting(false);
				setStartError(
					failure instanceof Error ? failure.message : "The link could not be started.",
				);
			},
		);
	}

	if (links.isPending) {
		return <p className="pk-text-body m-0 text-ink-muted">Loading linked accounts…</p>;
	}
	if (!links.isSuccess) {
		return (
			<p className="pk-text-body m-0 text-status-error" data-testid="links-error">
				Your linked accounts could not be loaded.
			</p>
		);
	}

	const { source, linkUntil, links: rows } = links.data;

	if (source === "course") {
		const open = linkUntil !== null && Date.parse(linkUntil) > Date.now();
		return (
			<div className="grid gap-2" data-testid="link-course">
				<p className="pk-text-compact m-0 text-ink-muted">
					You opened Portikus from your course. If you also sign in with your SSO
					account, link the two so your course opens that account and its workspace.
					This course account's workspace is archived, not deleted.
				</p>
				{open && !waiting ? (
					<div>
						<Button
							ref={startButton}
							variant="primary"
							data-testid="link-start"
							onClick={openLinkTab}
						>
							Link to my SSO account
						</Button>
					</div>
				) : null}
				{open && waiting ? (
					<div>
						<Button ref={reopenButton} variant="secondary" onClick={openLinkTab}>
							Open the sign-in tab again
						</Button>
					</div>
				) : null}
				{open ? null : (
					<p className="pk-text-body m-0 text-ink" data-testid="link-too-late">
						Open Portikus again from your course to link it.
					</p>
				)}
				<p role="status" className="pk-text-compact m-0 text-ink-muted">
					{waiting ? "Finish signing in in the new tab." : ""}
				</p>
				{startError ? (
					<p className="pk-text-body m-0 text-status-error" role="alert">
						{startError}
					</p>
				) : null}
			</div>
		);
	}

	return (
		<div className="grid gap-2" data-testid="link-sso">
			{rows.length === 0 ? (
				<p className="pk-text-compact m-0 text-ink-muted">
					No course sign-ins are linked to this SSO account. To link one, open Portikus
					from your course and choose Link to my SSO account in Settings.
				</p>
			) : (
				<ul className="m-0 grid list-none gap-2 p-0">
					{rows.map((row) => (
						<li
							key={row.courseUserId}
							className="flex items-center justify-between gap-3"
							data-testid={`link-row-${row.courseUserId}`}
						>
							<span className="pk-text-body text-ink">
								{row.displayName}, {row.platformName}
							</span>
							<Button
								variant="secondary"
								aria-label={`Unlink ${row.displayName} from ${row.platformName}`}
								data-unlink-id={row.courseUserId}
								loading={unlink.isPending && unlink.variables === row.courseUserId}
								onClick={() => {
									const index = rows.indexOf(row);
									const next = rows[index + 1] ?? rows[index - 1];
									unlink.mutate(row.courseUserId, {
										// Runs after useUnlink's refetch, so the row is gone; the frame lets React render.
										onSuccess: () =>
											requestAnimationFrame(() => {
												const button = next
													? document.querySelector<HTMLElement>(
															`[data-unlink-id="${next.courseUserId}"]`,
														)
													: null;
												(
													button ?? document.getElementById("settings-profile-linked")
												)?.focus();
											}),
									});
								}}
							>
								Unlink
							</Button>
						</li>
					))}
				</ul>
			)}
			<p role="status" className="pk-text-compact m-0 text-ink-muted">
				{unlink.isSuccess
					? "Unlinked. Your next launch from that course opens the course account."
					: ""}
			</p>
			{unlink.error ? (
				<p className="pk-text-body m-0 text-status-error" role="alert">
					{unlink.error.message}
				</p>
			) : null}
		</div>
	);
}

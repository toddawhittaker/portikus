import { StartLinkResponse } from "@portikus/contracts";
import { Button } from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import { request } from "../api/request.js";
import { StandalonePage } from "../pages/StandalonePage.js";
import { leaveLinkTab } from "./channel.js";

/**
 * Opened in a new tab by Settings (docs/EPIC-13-1.md, "The flow" step 2):
 * starts the link, then replaces itself with the SSO sign-in. The new tab
 * shares the cookie jar, so it carries the same course session.
 */
export function LinkStartPage() {
	const [error, setError] = useState<string | null>(null);
	const started = useRef(false);

	useEffect(() => {
		// Strict mode runs effects twice; one start per page load.
		if (started.current) return;
		started.current = true;
		request(StartLinkResponse, "/me/links/start", { method: "POST" }).then(
			({ redirectUrl }) => location.replace(redirectUrl),
			(failure: unknown) =>
				setError(
					failure instanceof Error ? failure.message : "The link could not be started.",
				),
		);
	}, []);

	if (error === null) {
		return (
			<StandalonePage title="Link accounts" testId="page-link-start">
				<h1 id="page-title" className="pk-text-display">
					Link accounts
				</h1>
				<p className="pk-text-body pk-muted" role="status">
					Opening the SSO sign-in…
				</p>
			</StandalonePage>
		);
	}

	return (
		<StandalonePage title="Accounts not linked" testId="page-link-start">
			<h1 id="page-title" className="pk-text-display">
				The link could not be started
			</h1>
			<p className="pk-text-body" role="alert" data-testid="link-error">
				{error}
			</p>
			<div className="pk-actions">
				<Button variant="secondary" onClick={leaveLinkTab}>
					Back to Portikus
				</Button>
			</div>
		</StandalonePage>
	);
}

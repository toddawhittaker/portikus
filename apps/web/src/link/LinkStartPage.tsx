import { StartLinkResponse } from "@portikus/contracts";
import { Button } from "@portikus/ui";
import { useState } from "react";
import { request } from "../api/request.js";
import { StandalonePage } from "../pages/StandalonePage.js";
import { leaveLinkTab } from "./channel.js";

/**
 * Where Settings goes when the browser blocks the new tab (docs/EPIC-13-1.md,
 * "The flow" step 2). It starts the link only on a click, so another site
 * that opens this address cannot reset a link in progress.
 */
export function LinkStartPage() {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function start() {
		setBusy(true);
		setError(null);
		request(StartLinkResponse, "/me/links/start", { method: "POST" }).then(
			({ redirectUrl }) => location.replace(redirectUrl),
			(failure: unknown) => {
				setBusy(false);
				setError(
					failure instanceof Error ? failure.message : "The link could not be started.",
				);
			},
		);
	}

	return (
		<StandalonePage title="Link accounts" testId="page-link-start">
			<h1 id="page-title" className="pk-text-display">
				Link accounts
			</h1>
			<p className="pk-text-body">
				Sign in with your SSO account next. Nothing is linked until you confirm.
			</p>
			<p className="pk-text-body pk-muted" role="status">
				{busy ? "Opening the SSO sign-in…" : ""}
			</p>
			{error ? (
				<p className="pk-text-body" role="alert" data-testid="link-error">
					{error}
				</p>
			) : null}
			<div className="pk-actions">
				<Button variant="secondary" onClick={leaveLinkTab} disabled={busy}>
					Back to Portikus
				</Button>
				<Button variant="primary" loading={busy} onClick={start}>
					Continue to SSO sign-in
				</Button>
			</div>
		</StandalonePage>
	);
}

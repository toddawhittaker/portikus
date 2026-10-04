import { useEffect, useRef } from "react";
import { StandalonePage } from "./StandalonePage.js";

/** A first sign-in with no invitation lands here; nobody signs themselves up (SPEC.md section 24.13). */
export function NotInvited() {
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => heading.current?.focus(), []);
	return (
		<StandalonePage title="Not set up" testId="page-not-invited">
			<h1 id="page-title" className="pk-text-display" tabIndex={-1} ref={heading}>
				Your account has not been set up on this site
			</h1>
			<p className="pk-text-body">Ask your administrator to invite you.</p>
			<p className="pk-text-body pk-muted">
				After they do, sign in again with the same account.
			</p>
			<div className="pk-actions">
				<a className="pk-link" href="/">
					Back to sign in
				</a>
			</div>
		</StandalonePage>
	);
}

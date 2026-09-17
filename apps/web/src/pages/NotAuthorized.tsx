import { Button } from "@portikus/ui";
import { useRef } from "react";
import { useMe } from "../useMe.js";
import { StandalonePage } from "./StandalonePage.js";

/**
 * The account is real but has no access to Portikus (SPEC.md §5.2). Access
 * comes from the institution's groups, so there is nothing to click here
 * except signing out.
 */
export function NotAuthorized() {
	const me = useMe();
	const signOutForm = useRef<HTMLFormElement>(null);
	const user = me.status === "authenticated" ? me.user : null;

	return (
		<StandalonePage testId="page-not-authorized">
			<div className="flex flex-col gap-2">
				<h1 id="page-title" className="pk-text-display">
					You don't have access to Portikus
				</h1>
				<p className="pk-text-body">
					You're signed in with your institution, but your account doesn't have access
					to Portikus.
				</p>
				<p className="pk-text-body pk-muted">
					Access is granted through groups your institution manages. If you think you
					should have access, send your instructor the account below.
				</p>
			</div>
			{user && (
				<div className="pk-account-box">
					<div className="flex min-w-0 flex-col">
						<span className="pk-text-label">{user.displayName}</span>
						<span className="pk-mono-small pk-muted">{user.email ?? "—"}</span>
					</div>
				</div>
			)}
			<div className="pk-actions">
				<Button
					variant="primary"
					iconStart="sign-out"
					data-testid="signout"
					onClick={() => signOutForm.current?.requestSubmit()}
				>
					Sign out
				</Button>
			</div>
			<form ref={signOutForm} method="post" action="/auth/logout" className="hidden" />
		</StandalonePage>
	);
}

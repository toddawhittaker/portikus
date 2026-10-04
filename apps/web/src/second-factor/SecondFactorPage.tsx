import { Button } from "@portikus/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { StandalonePage } from "../pages/StandalonePage.js";
import { useMe } from "../useMe.js";
import { EnrolTotp } from "./EnrolTotp.js";
import { RecoveryCodes } from "./RecoveryCodes.js";
import { VerifyCode } from "./VerifyCode.js";

/**
 * Two-step sign-in for an account with a Portikus password (SPEC.md
 * section 24.13): set up an authenticator app, or enter a code from it.
 * The router sends every page here while the gate holds.
 */
export function SecondFactorPage() {
	const me = useMe();
	const client = useQueryClient();
	const navigate = useNavigate();
	const signOutForm = useRef<HTMLFormElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	// Kept here, so a refetch of the session cannot hide them before they are saved.
	const [codes, setCodes] = useState<string[] | null>(null);
	const mode = me.status === "authenticated" ? me.user.secondFactor : null;
	// The heading renders once the session loads, and changes after enrolment.
	useEffect(() => {
		if (mode !== null || codes !== null) heading.current?.focus();
	}, [mode, codes]);

	async function done() {
		// The gate is clear now; refetch so the router stops sending pages here.
		await client.refetchQueries({ queryKey: ["me"] });
		await navigate({ to: "/", replace: true });
	}

	if (me.status === "loading") return <div className="pk-root" aria-busy="true" />;
	if (me.status !== "authenticated") return <Navigate to="/" replace />;
	if (codes === null && mode === null) return <Navigate to="/" replace />;

	const title =
		codes !== null
			? "Save your recovery codes"
			: mode === "verify"
				? "Two-step sign-in"
				: "Set up two-step sign-in";

	return (
		<StandalonePage title={title} testId="page-second-factor">
			<div className="flex flex-col gap-2">
				<h1 id="page-title" className="pk-text-display" tabIndex={-1} ref={heading}>
					{title}
				</h1>
				<p className="pk-text-body">
					{codes !== null
						? "Each code signs you in once if you lose your phone. Keep them somewhere safe; they are not shown again."
						: mode === "verify"
							? "Enter the code from your authenticator app to finish signing in."
							: "Your Portikus password needs a second step. Set up an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or 1Password."}
				</p>
			</div>
			{codes !== null ? (
				<RecoveryCodes codes={codes} onDone={done} />
			) : mode === "verify" ? (
				<VerifyCode onVerified={done} />
			) : (
				<EnrolTotp onEnrolled={setCodes} />
			)}
			{codes === null ? (
				<>
					<hr className="pk-divider" />
					<div className="pk-actions">
						<Button
							variant="secondary"
							iconStart="sign-out"
							onClick={() => signOutForm.current?.requestSubmit()}
						>
							Sign out
						</Button>
					</div>
					<form
						ref={signOutForm}
						method="post"
						action="/auth/logout"
						className="hidden"
					/>
				</>
			) : null}
		</StandalonePage>
	);
}

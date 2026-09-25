import { Button, useToast } from "@portikus/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import { StandalonePage } from "../pages/StandalonePage.js";
import { useMe } from "../useMe.js";
import { ChangePasswordForm } from "./ChangePasswordForm.js";

/**
 * The only page an account with "must change password" can reach
 * (SPEC.md section 5.3); the router sends every other page here.
 */
export function ChangePasswordPage() {
	const me = useMe();
	const client = useQueryClient();
	const navigate = useNavigate();
	const toast = useToast();
	const signOutForm = useRef<HTMLFormElement>(null);

	if (me.status === "loading") return <div className="pk-root" aria-busy="true" />;
	if (me.status !== "authenticated") return <Navigate to="/" replace />;

	async function changed() {
		toast.show({
			tone: "success",
			title: "Password changed. The one-time password no longer works.",
		});
		// The flag is clear now; refetch so the router stops sending pages here.
		await client.refetchQueries({ queryKey: ["me"] });
		await navigate({ to: "/", replace: true });
	}

	return (
		<StandalonePage title="Set a new password" testId="page-change-password">
			<div className="flex flex-col gap-2">
				<h1 id="page-title" className="pk-text-display">
					Set a new password
				</h1>
				<p className="pk-text-body">
					Choose your own password before you continue. Only you will know it.
				</p>
			</div>
			<ChangePasswordForm idPrefix="change-password" onChanged={changed} />
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
			<form ref={signOutForm} method="post" action="/auth/logout" className="hidden" />
		</StandalonePage>
	);
}

import { Button, TextField } from "@portikus/ui";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { errorText, sendJson } from "../api/request.js";
import { StandalonePage } from "../pages/StandalonePage.js";

/**
 * Ask for an emailed reset link (SPEC.md section 5.3). The answer is the
 * same for every address, so the page never says whether an account exists.
 */
export function ForgotPasswordPage() {
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => heading.current?.focus(), []);
	const [login, setLogin] = useState("");
	const [fieldError, setFieldError] = useState<string | undefined>();
	const ask = useMutation({
		mutationFn: (body: { login: string }) =>
			sendJson(z.object({}), "/auth/password-reset", body),
	});

	function submit() {
		if (ask.isPending) return;
		if (login.trim() === "") {
			setFieldError("Enter the email address you sign in with.");
			document.getElementById("forgot-login")?.focus();
			return;
		}
		setFieldError(undefined);
		ask.mutate({ login: login.trim() });
	}

	return (
		<StandalonePage title="Forgot your password" testId="page-forgot-password">
			<div className="flex flex-col gap-2">
				<h1 id="page-title" className="pk-text-display" tabIndex={-1} ref={heading}>
					Forgot your password?
				</h1>
				<p className="pk-text-body">
					Enter the email address you sign in with, and we will email you a link to
					choose a new password.
				</p>
				<p className="pk-text-body pk-muted">
					This works only for accounts with a password on this site, and only when your
					site sends account email. If you sign in through your school, or no email
					arrives, ask your administrator.
				</p>
			</div>
			{ask.isSuccess ? (
				<p role="status" className="pk-text-body m-0">
					If that address belongs to an account here, a link is on its way. It works
					once and lasts 30 minutes.
				</p>
			) : (
				<form
					className="grid gap-4"
					noValidate
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<TextField
						id="forgot-login"
						label="Email address"
						type="email"
						autoComplete="username"
						value={login}
						error={fieldError}
						onChange={(event) => setLogin(event.target.value)}
					/>
					{ask.error ? (
						<p role="alert" className="pk-text-body m-0 text-status-error">
							{errorText(ask.error, "Your request was not sent. Try again.")}
						</p>
					) : null}
					<div>
						<Button type="submit" variant="primary" loading={ask.isPending}>
							Email me a link
						</Button>
					</div>
				</form>
			)}
			<div className="pk-actions">
				<a className="pk-link" href="/">
					Back to sign in
				</a>
			</div>
		</StandalonePage>
	);
}

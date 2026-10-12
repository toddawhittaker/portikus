import { Button, TextField } from "@portikus/ui";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { z } from "zod";
import { ApiError, errorText, sendJson } from "../api/request.js";
import { StandalonePage } from "../pages/StandalonePage.js";
import { checkNewPassword, NEW_PASSWORD_HINT } from "./ChangePasswordForm.js";

type Errors = { next?: string; confirm?: string };

/** The token rides in the link's fragment, so no server or log ever sees it (SPEC.md section 5.3). */
function tokenFromHash(): string {
	return window.location.hash.slice(1);
}

/**
 * Choose a new password from an emailed reset or invitation link. Starts no
 * session: the person signs in afterwards, second factor and all.
 */
export function ResetPasswordPage() {
	const [token] = useState(tokenFromHash);
	const heading = useRef<HTMLHeadingElement>(null);
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [errors, setErrors] = useState<Errors>({});
	const complete = useMutation({
		mutationFn: (body: { token: string; password: string }) =>
			sendJson(z.undefined(), "/auth/password-reset/complete", body),
	});

	useEffect(() => {
		// Off the address bar and out of history, so the link is not shared or reopened.
		if (window.location.hash) {
			window.history.replaceState(null, "", window.location.pathname);
		}
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the success view brings a new heading to focus
	useEffect(() => {
		heading.current?.focus();
	}, [complete.isSuccess]);

	function showErrors(found: Errors) {
		// Render the invalid state before focus lands, so it is announced.
		flushSync(() => setErrors(found));
		const first = found.next ? "reset-next" : found.confirm ? "reset-confirm" : null;
		if (first) document.getElementById(first)?.focus();
	}

	async function submit() {
		if (complete.isPending) return;
		const found = checkNewPassword(next, confirm);
		if (found.next || found.confirm) {
			complete.reset();
			showErrors(found);
			return;
		}
		setErrors({});
		try {
			await complete.mutateAsync({ token, password: next });
		} catch (error) {
			if (error instanceof ApiError && error.code === "VALIDATION_FAILED") {
				showErrors({ next: error.message });
			}
		}
	}

	const askAgain = (
		<div className="pk-actions">
			<a className="pk-link" href="/forgot-password">
				Ask for a new link
			</a>
		</div>
	);

	if (complete.isSuccess) {
		return (
			<StandalonePage title="Password changed" testId="page-reset-password">
				<h1 id="page-title" className="pk-text-display" tabIndex={-1} ref={heading}>
					Your password was changed
				</h1>
				<p className="pk-text-body">
					Every session of your account was signed out. Sign in with your new password.
				</p>
				<div className="pk-actions">
					<a className="pk-link" href="/">
						Sign in
					</a>
				</div>
			</StandalonePage>
		);
	}

	if (token === "") {
		return (
			<StandalonePage title="Choose a new password" testId="page-reset-password">
				<h1 id="page-title" className="pk-text-display" tabIndex={-1} ref={heading}>
					This link is incomplete
				</h1>
				<p className="pk-text-body">
					Open the link from your email again, or ask for a new one.
				</p>
				{askAgain}
			</StandalonePage>
		);
	}

	const error = complete.error;
	const badLink = error instanceof ApiError && error.code === "RESET_LINK_INVALID";
	const onField = error instanceof ApiError && error.code === "VALIDATION_FAILED";

	return (
		<StandalonePage title="Choose a new password" testId="page-reset-password">
			<div className="flex flex-col gap-2">
				<h1 id="page-title" className="pk-text-display" tabIndex={-1} ref={heading}>
					Choose a new password
				</h1>
				<p className="pk-text-body">
					Every session of your account is signed out when you save it.
				</p>
			</div>
			<form
				className="grid gap-4"
				noValidate
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<TextField
					id="reset-next"
					label="New password"
					type="password"
					autoComplete="new-password"
					hint={NEW_PASSWORD_HINT}
					value={next}
					error={errors.next}
					onChange={(event) => setNext(event.target.value)}
				/>
				<TextField
					id="reset-confirm"
					label="New password again"
					type="password"
					autoComplete="new-password"
					value={confirm}
					error={errors.confirm}
					onChange={(event) => setConfirm(event.target.value)}
				/>
				{error && !onField ? (
					<p role="alert" className="pk-text-body m-0 text-status-error">
						{errorText(error, "Your password was not changed. Try again.")}
					</p>
				) : null}
				<div>
					<Button type="submit" variant="primary" loading={complete.isPending}>
						Save new password
					</Button>
				</div>
			</form>
			{badLink ? askAgain : null}
		</StandalonePage>
	);
}

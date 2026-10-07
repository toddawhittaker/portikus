import type { LinkError } from "@portikus/contracts";
import { Button, TextField } from "@portikus/ui";
import { useState } from "react";
import { flushSync } from "react-dom";
import { ApiError } from "../api/request.js";
import { StandalonePage } from "../pages/StandalonePage.js";
import { focusField } from "../second-factor/focusField.js";
import { announceLink, leaveLinkTab } from "./channel.js";
import { useConfirmLink, usePendingLink } from "./queries.js";

/** What each refusal from the SSO sign-in means to the person (ADR 0026). */
export const LINK_ERROR_MESSAGES: Record<LinkError, string> = {
	no_account:
		"That SSO account has never signed in to Portikus. Sign in to Portikus with it once, then open Portikus from your course and try again.",
	not_authorized:
		"That SSO account does not have access to Portikus, so it cannot be linked.",
	session_changed:
		"You signed in or out somewhere else while linking. Open Portikus again from your course and start again.",
	expired:
		"The link request expired or was already used. Open Portikus again from your course and start again.",
	already_linked:
		"That SSO account is already linked to a course sign-in from this course system. Unlink it in that account's Settings first.",
	failed:
		"The accounts could not be linked. Open Portikus again from your course and try again.",
};

const CODE_ID = "link-code";

/** A 404 from confirm means the pending link is gone, not that the code was wrong. */
function isExpired(error: unknown): boolean {
	return error instanceof ApiError && error.status === 404;
}

/** Tell the tab that started the link, then close this one; it stays open only if the browser refuses. */
function finishLinked() {
	announceLink({ type: "linked" });
	window.close();
}

/**
 * The confirmation page after the SSO sign-in (ADR 0026). It names both accounts; nothing is linked until
 * Link accounts is pressed.
 */
export function LinkPage({ error }: { error: LinkError | undefined }) {
	const pending = usePendingLink(error === undefined);
	const confirm = useConfirmLink();
	const [code, setCode] = useState("");
	// Kept apart from confirm.error so it renders before focus moves to the field.
	const [codeError, setCodeError] = useState<string | undefined>();

	if (error) {
		return (
			<StandalonePage title="Accounts not linked" testId="page-link">
				<h1 id="page-title" className="pk-text-display">
					Your accounts were not linked
				</h1>
				<p className="pk-text-body" role="alert" data-testid="link-error">
					{LINK_ERROR_MESSAGES[error]}
				</p>
				<div className="pk-actions">
					<Button variant="secondary" onClick={leaveLinkTab}>
						Back to Portikus
					</Button>
				</div>
			</StandalonePage>
		);
	}

	if (pending.isPending) {
		return (
			<StandalonePage title="Link accounts" testId="page-link">
				<h1 id="page-title" className="pk-text-display">
					Link accounts
				</h1>
				<p className="pk-text-body pk-muted" role="status">
					Loading the accounts to link…
				</p>
			</StandalonePage>
		);
	}

	if (!pending.data) {
		return (
			<StandalonePage title="Link accounts" testId="page-link">
				<h1 id="page-title" className="pk-text-display">
					No link is waiting
				</h1>
				<p className="pk-text-body" role="alert" data-testid="link-error">
					{pending.isError
						? "The link could not be loaded. Open Portikus again from your course and try again."
						: LINK_ERROR_MESSAGES.expired}
				</p>
				<div className="pk-actions">
					<Button variant="secondary" onClick={leaveLinkTab}>
						Back to Portikus
					</Button>
				</div>
			</StandalonePage>
		);
	}

	if (confirm.isSuccess) {
		return (
			<StandalonePage title="Accounts linked" testId="page-link">
				<h1 id="page-title" className="pk-text-display">
					Accounts linked
				</h1>
				<p className="pk-text-body" role="status" data-testid="link-done">
					Linked. You can close this tab.
				</p>
				<div className="pk-actions">
					{/* A full load, because confirming changed who is signed in. */}
					<a className="pk-text-body" href="/">
						Go to Portikus
					</a>
				</div>
			</StandalonePage>
		);
	}

	const { course, sso, secondFactor } = pending.data;
	const confirmError = isExpired(confirm.error)
		? LINK_ERROR_MESSAGES.expired
		: confirm.error?.message;
	const busy = confirm.isPending;

	function submit() {
		setCodeError(undefined);
		confirm.mutate(code.trim() || undefined, {
			onSuccess: finishLinked,
			onError: (failure) => {
				if (secondFactor !== "verify" || isExpired(failure)) return;
				// The field carries the error so a screen reader reads it with the label (SPEC.md 25.8).
				flushSync(() => setCodeError(failure.message));
				focusField(CODE_ID);
			},
		});
	}

	return (
		<StandalonePage title="Link accounts" testId="page-link">
			<h1 id="page-title" className="pk-text-display">
				Link your accounts?
			</h1>
			<p className="pk-text-body">
				From now on, opening Portikus from your course signs you in to your SSO account
				and its workspace. Your course account's workspace is archived, not deleted, and
				you can unlink later from Settings.
			</p>
			<dl className="grid gap-3" data-testid="link-accounts">
				<div className="pk-account-box">
					<dt className="pk-text-label">Course account</dt>
					<dd className="m-0 flex min-w-0 flex-col">
						<span className="pk-text-body">{course.displayName}</span>
						<span className="pk-mono-small pk-muted">{course.platformName}</span>
					</dd>
				</div>
				<div className="pk-account-box">
					<dt className="pk-text-label">SSO account</dt>
					<dd className="m-0 flex min-w-0 flex-col">
						<span className="pk-text-body">{sso.displayName}</span>
						<span className="pk-mono-small pk-muted">
							{sso.signInName ?? sso.email ?? "—"}
						</span>
						{sso.signInName && sso.email ? (
							<span className="pk-mono-small pk-muted">{sso.email}</span>
						) : null}
					</dd>
				</div>
			</dl>
			{/* Always mounted so it announces; while empty it leaves the flow, so the panel adds no gap for it. */}
			<p
				className="pk-text-body pk-muted empty:absolute"
				role="status"
				data-testid="link-status"
			>
				{busy ? "Linking your accounts…" : null}
			</p>
			{secondFactor === "enrol" ? (
				<p className="pk-text-body" role="alert" data-testid="link-error">
					This SSO account signs in with a Portikus password, so it needs two-step
					sign-in before it can be linked. Sign in to Portikus with it and set up
					two-step sign-in, then open Portikus from your course and link again.
				</p>
			) : null}
			{secondFactor === "verify" ? (
				<TextField
					id={CODE_ID}
					label="Two-step sign-in code"
					hint="A code from your authenticator app, or one of your recovery codes."
					autoComplete="one-time-code"
					spellCheck={false}
					value={code}
					error={codeError}
					onChange={(event) => setCode(event.target.value)}
				/>
			) : null}
			{confirmError && !codeError ? (
				<p
					className="pk-text-body text-status-error"
					role="alert"
					data-testid="link-error"
				>
					{confirmError}
				</p>
			) : null}
			<div className="pk-actions">
				<Button variant="secondary" onClick={leaveLinkTab} disabled={busy}>
					Cancel
				</Button>
				{secondFactor === "enrol" ? null : (
					<Button
						variant="primary"
						data-testid="link-confirm"
						loading={busy}
						onClick={submit}
					>
						Link accounts
					</Button>
				)}
			</div>
		</StandalonePage>
	);
}

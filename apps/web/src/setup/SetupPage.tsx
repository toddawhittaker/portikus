import { FirstAccountRequest, SetupState } from "@portikus/contracts";
import { Button, TextField } from "@portikus/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { z } from "zod";
import { request } from "../api/request.js";
import { StandalonePage } from "../pages/StandalonePage.js";
import { useMe } from "../useMe.js";

/**
 * `/setup`: the first administrator enters the one-time setup code printed on
 * the server (docs/archive/epics/EPIC-14.md rulings 15 to 18). Signed in, the code makes
 * this account an administrator. Signed out on a standalone Dex site with no
 * administrator, the code creates the first account instead.
 */

const LINK_CLASS =
	"pk-btn pk-focus-ring inline-flex h-[var(--size-control-lg)] w-full items-center justify-center rounded-sm bg-surface-inverse px-5 font-medium text-[15px] text-ink-inverse no-underline hover:bg-surface-inverse-hover";

/** Both setup posts answer 204 on success. */
function post(url: string, body: object): Promise<undefined> {
	return request(z.undefined(), url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** A server error. The caller keys it by attempt so a repeat is announced again. */
function ErrorLine({ error }: { error: string | null }) {
	if (!error) return null;
	return (
		<p
			className="pk-text-body text-status-error"
			role="alert"
			data-testid="setup-error"
		>
			{error}
		</p>
	);
}

function messageOf(error: unknown): string | null {
	if (!error) return null;
	return error instanceof Error
		? error.message
		: "Something went wrong. Please try again.";
}

/** Takes focus when it appears, so the result is read out (SPEC.md 25.8). */
function DoneMessage({ children }: { children: React.ReactNode }) {
	const ref = useRef<HTMLParagraphElement>(null);
	useEffect(() => ref.current?.focus(), []);
	return (
		<p
			ref={ref}
			tabIndex={-1}
			className="pk-text-body outline-none"
			role="status"
			data-testid="setup-done"
		>
			{children}
		</p>
	);
}

type Field = "email" | "username" | "password" | "again" | "code";
const FIELD_ORDER: Field[] = ["email", "username", "password", "again", "code"];
const FIELD_ID: Record<Field, string> = {
	email: "setup-email",
	username: "setup-username",
	password: "setup-password",
	again: "setup-password-again",
	code: "setup-code",
};
const FIELD_ERROR: Record<Exclude<Field, "again">, string> = {
	email: "Enter an email address.",
	username:
		"Use 1 to 64 letters, digits, dots, dashes or underscores for the username.",
	password: "Use a password of 12 to 72 characters.",
	code: "Enter the setup code.",
};

/** Focus a field even if it already has focus, so its error is read again. */
function focusField(id: string) {
	const input = document.getElementById(id);
	input?.blur();
	input?.focus();
}

function ClaimForm() {
	const queryClient = useQueryClient();
	const [code, setCode] = useState("");
	const [attempt, setAttempt] = useState(0);
	const claim = useMutation({
		mutationFn: () => post("/setup/claim", { code }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
	});

	if (claim.isSuccess) {
		return (
			<>
				<DoneMessage>You are now an administrator.</DoneMessage>
				<a href="/admin" className={LINK_CLASS} data-testid="setup-admin-link">
					Open Administration
				</a>
			</>
		);
	}

	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				if (!claim.isPending && code.trim() !== "") {
					setAttempt((n) => n + 1);
					claim.mutate();
				}
			}}
		>
			<p className="pk-text-body pk-muted">
				Enter the setup code printed on the server. It makes the account you are signed
				in with an administrator.
			</p>
			<TextField
				id="setup-code"
				label="Setup code"
				mono
				autoComplete="off"
				spellCheck={false}
				placeholder="XXXX-XXXX-XXXX-XXXX"
				data-testid="setup-code"
				value={code}
				onChange={(event) => setCode(event.target.value)}
			/>
			<ErrorLine key={attempt} error={messageOf(claim.error)} />
			<Button variant="primary" type="submit" loading={claim.isPending}>
				Become administrator
			</Button>
		</form>
	);
}

function FirstAccountForm() {
	const [email, setEmail] = useState("");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [again, setAgain] = useState("");
	const [code, setCode] = useState("");
	const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
	const [attempt, setAttempt] = useState(0);
	const create = useMutation({
		mutationFn: (body: FirstAccountRequest) => post("/setup/first-account", body),
	});

	if (create.isSuccess) {
		return (
			<>
				<DoneMessage>
					Your administrator account is ready. Sign in with its email and password.
				</DoneMessage>
				<a href="/auth/login" className={LINK_CLASS} data-testid="setup-signin">
					Sign in
				</a>
			</>
		);
	}

	function submit() {
		if (create.isPending) return;
		const found: Partial<Record<Field, string>> = {};
		const body = FirstAccountRequest.safeParse({ email, username, password, code });
		if (!body.success) {
			for (const issue of body.error.issues) {
				const field = issue.path[0] as Exclude<Field, "again">;
				found[field] = FIELD_ERROR[field];
			}
		}
		if (password !== again) found.again = "The two passwords do not match.";
		// Render the invalid state before focus lands, so it is announced.
		flushSync(() => setErrors(found));
		const first = FIELD_ORDER.find((field) => found[field]);
		if (first) {
			focusField(FIELD_ID[first]);
			return;
		}
		if (!body.success) return;
		setAttempt((n) => n + 1);
		create.mutate(body.data);
	}

	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<p className="pk-text-body pk-muted">
				Nobody can sign in yet. Create the first administrator account with the setup
				code printed on the server.
			</p>
			<TextField
				id="setup-email"
				label="Email"
				type="email"
				autoComplete="email"
				value={email}
				error={errors.email}
				onChange={(event) => setEmail(event.target.value)}
			/>
			<TextField
				id="setup-username"
				label="Username"
				mono
				autoComplete="username"
				value={username}
				error={errors.username}
				onChange={(event) => setUsername(event.target.value)}
			/>
			<TextField
				id="setup-password"
				label="Password"
				type="password"
				autoComplete="new-password"
				hint="12 to 72 characters."
				value={password}
				error={errors.password}
				onChange={(event) => setPassword(event.target.value)}
			/>
			<TextField
				id="setup-password-again"
				label="Password again"
				type="password"
				autoComplete="new-password"
				value={again}
				error={errors.again}
				onChange={(event) => setAgain(event.target.value)}
			/>
			<TextField
				id="setup-code"
				label="Setup code"
				mono
				autoComplete="off"
				spellCheck={false}
				placeholder="XXXX-XXXX-XXXX-XXXX"
				value={code}
				error={errors.code}
				onChange={(event) => setCode(event.target.value)}
			/>
			<ErrorLine key={attempt} error={messageOf(create.error)} />
			<Button variant="primary" type="submit" loading={create.isPending}>
				Create administrator account
			</Button>
		</form>
	);
}

export function SetupPage() {
	const me = useMe();
	const state = useQuery({
		queryKey: ["setup-state"],
		queryFn: () => request(SetupState, "/setup/state"),
		enabled: me.status === "anonymous",
	});

	let body: React.ReactNode;
	if (me.status === "authenticated") {
		body = <ClaimForm />;
	} else if (me.status === "forbidden") {
		body = (
			<p className="pk-text-body">
				This account has no access to Portikus, so it cannot use a setup code.
			</p>
		);
	} else if (me.status === "anonymous" && state.data?.firstAccount) {
		body = <FirstAccountForm />;
	} else if (me.status === "anonymous" && state.data) {
		body = (
			<>
				<p className="pk-text-body pk-muted">
					Sign in first, then open this page again to enter the setup code.
				</p>
				<a href="/auth/login" className={LINK_CLASS} data-testid="setup-signin">
					Sign in
				</a>
			</>
		);
	} else if (state.isError) {
		body = <ErrorLine error={messageOf(state.error)} />;
	} else {
		body = <div aria-busy="true" />;
	}

	return (
		<StandalonePage title="Set up Portikus" testId="page-setup">
			<h1 id="page-title" className="pk-text-display">
				Set up Portikus
			</h1>
			{body}
		</StandalonePage>
	);
}

/**
 * Current password and the new one twice, for a Dex local password
 * (SPEC.md section 5.3). The change page and Settings, Password
 * both use it.
 */
import { Button, TextField } from "@portikus/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { flushSync } from "react-dom";
import { z } from "zod";
import { ApiError, request } from "../api/request.js";

/** The server's minimum (contracts ChangePasswordRequest). */
export const MIN_PASSWORD_LENGTH = 15;
const MAX_PASSWORD_BYTES = 72;

export const NEW_PASSWORD_HINT = `At least ${MIN_PASSWORD_LENGTH} characters. A few unrelated words make a strong one.`;

type Field = "current" | "next" | "confirm";
type Errors = Partial<Record<Field, string>>;

const FIELDS: readonly Field[] = ["current", "next", "confirm"];

/** The errors a draft has before anything is sent. */
export function checkPasswords(current: string, next: string, confirm: string): Errors {
	const errors: Errors = {};
	if (current === "") errors.current = "Enter your current password.";
	if (next.length < MIN_PASSWORD_LENGTH) {
		errors.next = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
	} else if (new TextEncoder().encode(next).length > MAX_PASSWORD_BYTES) {
		errors.next =
			"That is too long. Use at most 72 bytes; accented letters and symbols count as more than one.";
	} else if (next === current) {
		errors.next = "Choose a password different from the current one.";
	}
	if (!errors.next && confirm !== next) {
		errors.confirm = "The two new passwords do not match.";
	}
	return errors;
}

export function ChangePasswordForm({
	idPrefix,
	onChanged,
}: {
	idPrefix: string;
	onChanged: () => void | Promise<void>;
}) {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [errors, setErrors] = useState<Errors>({});
	const change = useMutation({
		mutationFn: (body: { currentPassword: string; newPassword: string }) =>
			request(z.undefined(), "/me/password", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
	});

	function showErrors(found: Errors) {
		// Render the invalid state before focus lands, so it is announced.
		flushSync(() => setErrors(found));
		const first = FIELDS.find((field) => found[field]);
		if (!first) return;
		// Blur first so focusing an already-focused field reads its error again.
		const input = document.getElementById(`${idPrefix}-${first}`);
		input?.blur();
		input?.focus();
	}

	async function submit() {
		if (change.isPending) return;
		const found = checkPasswords(current, next, confirm);
		if (Object.keys(found).length > 0) {
			change.reset();
			showErrors(found);
			return;
		}
		setErrors({});
		try {
			await change.mutateAsync({ currentPassword: current, newPassword: next });
		} catch (error) {
			if (error instanceof ApiError && error.code === "WRONG_PASSWORD") {
				showErrors({ current: error.message });
			} else if (error instanceof ApiError && error.code === "VALIDATION_FAILED") {
				showErrors({ next: error.message });
			}
			return;
		}
		setCurrent("");
		setNext("");
		setConfirm("");
		await onChanged();
	}

	const error = change.error;
	const onField =
		error instanceof ApiError &&
		(error.code === "WRONG_PASSWORD" || error.code === "VALIDATION_FAILED");

	return (
		<form
			className="grid gap-4"
			noValidate
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<TextField
				id={`${idPrefix}-current`}
				label="Current password"
				type="password"
				autoComplete="current-password"
				value={current}
				error={errors.current}
				onChange={(event) => setCurrent(event.target.value)}
			/>
			<TextField
				id={`${idPrefix}-next`}
				label="New password"
				type="password"
				autoComplete="new-password"
				hint={NEW_PASSWORD_HINT}
				value={next}
				error={errors.next}
				onChange={(event) => setNext(event.target.value)}
			/>
			<TextField
				id={`${idPrefix}-confirm`}
				label="New password again"
				type="password"
				autoComplete="new-password"
				value={confirm}
				error={errors.confirm}
				onChange={(event) => setConfirm(event.target.value)}
			/>
			{error && !onField ? (
				<p role="alert" className="pk-text-body m-0 text-status-error">
					{error.message}
				</p>
			) : null}
			<div>
				<Button type="submit" variant="primary" loading={change.isPending}>
					Change password
				</Button>
			</div>
		</form>
	);
}

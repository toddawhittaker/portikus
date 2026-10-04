import { Button, TextField } from "@portikus/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { flushSync } from "react-dom";
import { z } from "zod";
import { errorText, sendJson } from "../api/request.js";
import { focusField } from "./focusField.js";

const CODE_ID = "verify-code";

/**
 * A code from the authenticator app, or one of the recovery codes, at
 * sign-in (SPEC.md section 24.13).
 */
export function VerifyCode({ onVerified }: { onVerified: () => void | Promise<void> }) {
	const [recovery, setRecovery] = useState(false);
	const [code, setCode] = useState("");
	const [error, setError] = useState<string | undefined>();
	const verify = useMutation({
		mutationFn: (body: { code: string }) =>
			sendJson(z.undefined(), "/me/second-factor/verify", body),
	});

	function showError(message: string) {
		flushSync(() => setError(message));
		focusField(CODE_ID);
	}

	async function submit() {
		if (verify.isPending) return;
		const typed = code.trim();
		if (typed === "") {
			showError(
				recovery ? "Enter a recovery code." : "Enter the 6-digit code from your app.",
			);
			return;
		}
		setError(undefined);
		try {
			await verify.mutateAsync({ code: typed });
		} catch (failure) {
			showError(errorText(failure, "That code could not be checked. Try again."));
			return;
		}
		await onVerified();
	}

	function switchMode() {
		flushSync(() => {
			setRecovery(!recovery);
			setCode("");
			setError(undefined);
		});
		focusField(CODE_ID);
	}

	return (
		<form
			className="grid gap-4"
			noValidate
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			{recovery ? (
				<TextField
					key="recovery"
					id={CODE_ID}
					label="Recovery code"
					hint="One of the codes you saved when you set up two-step sign-in. Each works once."
					autoComplete="off"
					autoCapitalize="characters"
					spellCheck={false}
					mono
					value={code}
					error={error}
					onChange={(event) => setCode(event.target.value)}
				/>
			) : (
				<TextField
					key="app"
					id={CODE_ID}
					label="Code from your app"
					inputMode="numeric"
					autoComplete="one-time-code"
					maxLength={7}
					value={code}
					error={error}
					onChange={(event) => setCode(event.target.value)}
				/>
			)}
			<div className="pk-actions justify-between">
				<Button type="button" variant="quiet" onClick={switchMode}>
					{recovery ? "Use your authenticator app" : "Use a recovery code"}
				</Button>
				<Button type="submit" variant="primary" loading={verify.isPending}>
					Continue
				</Button>
			</div>
		</form>
	);
}

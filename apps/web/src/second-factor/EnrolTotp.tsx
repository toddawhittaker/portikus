import { TotpEnrolDone, TotpEnrolStart } from "@portikus/contracts";
import { Button, TextField } from "@portikus/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { flushSync } from "react-dom";
import { ApiError, errorText, sendJson } from "../api/request.js";
import { CopyButton } from "./CopyButton.js";
import { focusField } from "./focusField.js";

const CODE_ID = "enrol-code";

/** Easier to read and type; authenticator apps ignore the spaces. */
export function groupsOfFour(secret: string): string {
	return secret.match(/.{1,4}/g)?.join(" ") ?? "";
}

/**
 * Scan the QR code, or type the key, then confirm with the first code
 * (SPEC.md section 24.13). The recovery codes come back on success.
 */
export function EnrolTotp({ onEnrolled }: { onEnrolled: (codes: string[]) => void }) {
	const [code, setCode] = useState("");
	const [error, setError] = useState<string | undefined>();
	const start = useQuery({
		queryKey: ["second-factor", "start"],
		queryFn: () => sendJson(TotpEnrolStart, "/me/second-factor/totp/start", {}),
		// One secret per visit: a refetch would replace what was just scanned.
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0,
		refetchOnWindowFocus: false,
	});
	const confirm = useMutation({
		mutationFn: (body: { token: string; code: string }) =>
			sendJson(TotpEnrolDone, "/me/second-factor/totp", body),
	});

	function showError(message: string) {
		flushSync(() => setError(message));
		focusField(CODE_ID);
	}

	async function submit() {
		if (!start.data || confirm.isPending) return;
		const typed = code.replace(/\s/g, "");
		if (!/^\d{6}$/.test(typed)) {
			showError("Enter the 6-digit code from your app.");
			return;
		}
		setError(undefined);
		try {
			const done = await confirm.mutateAsync({ token: start.data.token, code: typed });
			onEnrolled(done.recoveryCodes);
		} catch (failure) {
			if (failure instanceof ApiError && failure.code === "VALIDATION_FAILED") {
				// The setup expired: a new secret must be scanned.
				await start.refetch();
			}
			showError(errorText(failure, "Two-step sign-in was not turned on. Try again."));
		}
	}

	if (start.isError) {
		return (
			<p role="alert" className="pk-text-body m-0 text-status-error">
				{errorText(start.error, "Setup could not start. Reload the page to try again.")}
			</p>
		);
	}
	if (!start.data) return <div aria-busy="true" />;

	return (
		<form
			className="grid gap-4"
			noValidate
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<ol className="pk-text-body m-0 grid gap-3 pl-5">
				<li>
					Scan this QR code with your authenticator app.
					<img
						src={start.data.qrCode}
						alt="QR code for your authenticator app"
						width={200}
						height={200}
						className="mt-2 block rounded-sm bg-white"
						data-testid="totp-qr"
					/>
				</li>
				<li>
					Can't scan it? Add an account by hand with this key:
					<span className="mt-1 flex flex-wrap items-center gap-2">
						<code
							className="pk-mono-body min-w-0 break-words"
							data-testid="totp-secret"
						>
							{groupsOfFour(start.data.secret)}
						</code>
						<CopyButton
							label="Copy key"
							text={start.data.secret}
							copied="Key copied."
							failed="Could not copy. Select the key instead."
						/>
					</span>
				</li>
				<li>Enter the 6-digit code the app shows.</li>
			</ol>
			<TextField
				id={CODE_ID}
				label="Code from your app"
				inputMode="numeric"
				autoComplete="one-time-code"
				maxLength={7}
				value={code}
				error={error}
				onChange={(event) => setCode(event.target.value)}
			/>
			<div>
				<Button type="submit" variant="primary" loading={confirm.isPending}>
					Turn on two-step sign-in
				</Button>
			</div>
		</form>
	);
}

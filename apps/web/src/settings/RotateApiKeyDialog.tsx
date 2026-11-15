import type { ApiKey, CreatedApiKey } from "@portikus/contracts";
import { ConfirmDialog, ConfirmDialogRoot } from "@portikus/ui";
import { useState } from "react";
import { flushSync } from "react-dom";
import { errorText } from "../api/request.js";
import { focusField } from "../second-factor/focusField.js";
import { useRotateApiKey } from "./apiKeyQueries.js";
import { MISSING_CODE, StepUpFields } from "./StepUpFields.js";

const CODE_ID = "api-key-rotate-code";

/** How the confirm words the key's new period. */
export function newPeriodText(periodDays: ApiKey["periodDays"]): string {
	return periodDays === null
		? "It still never expires"
		: `It starts a fresh ${periodDays}-day period`;
}

/**
 * The confirm for Renew with a new secret (SPEC.md section 24.13). It names
 * the key by its prefix and last use, so the owner can tell whether it
 * leaked. A Dex local-password account proves a code or a passkey here, as it
 * does to create a key; other accounts owe no check.
 */
export function RotateApiKeyDialog({
	apiKey: key,
	lastUsed,
	open,
	needsSecondFactor,
	onClose,
	onRotated,
	returnFocusTo,
}: {
	apiKey: ApiKey;
	/** "Never used", or how long ago, as the row shows it. */
	lastUsed: string;
	open: boolean;
	needsSecondFactor: boolean;
	onClose: () => void;
	onRotated: (created: CreatedApiKey) => void;
	returnFocusTo: () => HTMLElement | null;
}) {
	const rotate = useRotateApiKey();
	const [code, setCode] = useState("");
	const [codeError, setCodeError] = useState<string | undefined>();

	function close() {
		if (rotate.isPending) return;
		rotate.reset();
		setCode("");
		setCodeError(undefined);
		onClose();
	}

	function done(created: CreatedApiKey) {
		setCode("");
		onRotated(created);
	}

	function confirm() {
		if (needsSecondFactor && code.trim() === "") {
			flushSync(() => setCodeError(MISSING_CODE));
			focusField(CODE_ID);
			return;
		}
		setCodeError(undefined);
		rotate.mutate(
			needsSecondFactor ? { id: key.id, code: code.trim() } : { id: key.id },
			{
				onSuccess: done,
				onError: (failure) => {
					if (!needsSecondFactor) return;
					// The field carries the refusal so it is read with its label (SPEC.md 25.8).
					flushSync(() => setCodeError(errorText(failure, "That code did not work.")));
					focusField(CODE_ID);
				},
			},
		);
	}

	const shownError = needsSecondFactor ? null : rotate.error;

	return (
		<ConfirmDialogRoot open={open} onOpenChange={(next) => !next && close()}>
			<ConfirmDialog
				testId="api-key-rotate-confirm"
				title={`Renew ${key.name} with a new secret?`}
				description={
					<>
						The key starting <span className="pk-mono-small">{key.prefix}</span> was
						last used {lastUsed === "Never used" ? "never" : lastUsed.toLowerCase()}.{" "}
						{newPeriodText(key.periodDays)}, and its old secret stops working at once,
						so every tool that uses it needs the new one. Use this if the secret may
						have leaked.
					</>
				}
				confirmLabel="Renew with a new secret"
				destructive={false}
				pending={rotate.isPending}
				onConfirm={confirm}
				returnFocusTo={returnFocusTo}
			>
				{needsSecondFactor ? (
					<div className="mt-3">
						<StepUpFields
							codeId={CODE_ID}
							code={code}
							codeError={codeError}
							onCodeChange={setCode}
							passkeyLabel="Renew with a passkey"
							passkeyTestId="api-key-rotate-passkey"
							onPasskey={async () =>
								done(await rotate.mutateAsync({ id: key.id, passkey: true }))
							}
						/>
					</div>
				) : null}
				{shownError ? (
					<p className="pk-text-body m-0 mt-3 text-status-error" role="alert">
						{errorText(shownError, "The key was not renewed. Try again.")}
					</p>
				) : null}
			</ConfirmDialog>
		</ConfirmDialogRoot>
	);
}

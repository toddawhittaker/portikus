import { SecondFactorStatus } from "@portikus/contracts";
import { LABEL_CLASS, TextField } from "@portikus/ui";
import { useQuery } from "@tanstack/react-query";
import { request } from "../api/request.js";
import { PasskeyButton } from "../second-factor/PasskeyButton.js";
import { passkeysSupported } from "../second-factor/passkey.js";

export const MISSING_CODE =
	"Enter a code from your authenticator app, or a recovery code.";

/**
 * The code-or-passkey step a Dex local-password account takes before it
 * creates a key or gives one a new secret (SPEC.md section 24.13). The
 * passkey button shows only when the account has a passkey.
 */
export function StepUpFields({
	codeId,
	code,
	codeError,
	onCodeChange,
	passkeyLabel,
	passkeyTestId,
	onPasskey,
}: {
	codeId: string;
	code: string;
	codeError: string | undefined;
	onCodeChange: (code: string) => void;
	passkeyLabel: string;
	passkeyTestId: string;
	/** Prove a passkey and run the action; a failure is shown beside the button. */
	onPasskey: () => Promise<void>;
}) {
	const factors = useQuery({
		queryKey: ["me", "api-keys", "second-factor"],
		queryFn: () => request(SecondFactorStatus, "/me/second-factor"),
	});
	const hasPasskey =
		factors.data?.factors.some((factor) => factor.kind === "webauthn") ?? false;
	return (
		<fieldset className="pk-key-options gap-3" data-testid="api-key-second-factor">
			<legend className={`${LABEL_CLASS} mb-1.5 p-0`}>Confirm it is you</legend>
			{hasPasskey && passkeysSupported() ? (
				<PasskeyButton label={passkeyLabel} testId={passkeyTestId} action={onPasskey} />
			) : null}
			<TextField
				id={codeId}
				label="Two-step sign-in code"
				hint="A code from your authenticator app, or one of your recovery codes."
				autoComplete="one-time-code"
				spellCheck={false}
				value={code}
				error={codeError}
				onChange={(event) => onCodeChange(event.target.value)}
			/>
		</fieldset>
	);
}

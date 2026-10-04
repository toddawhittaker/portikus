import { Button } from "@portikus/ui";
import { useState } from "react";
import { passkeyErrorText } from "./passkey.js";

/**
 * One passkey action, such as creating one or signing in with one
 * (SPEC.md section 24.13). A failure is announced beside the button.
 */
export function PasskeyButton({
	label,
	action,
	testId,
}: {
	label: string;
	action: () => Promise<void>;
	testId?: string;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	async function run() {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			await action();
		} catch (failure) {
			setError(passkeyErrorText(failure));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="grid gap-2">
			<div>
				<Button
					type="button"
					variant="secondary"
					iconStart="lock"
					loading={busy}
					onClick={() => void run()}
					data-testid={testId}
				>
					{label}
				</Button>
			</div>
			{error ? (
				<p role="alert" className="pk-text-body m-0 text-status-error">
					{error}
				</p>
			) : null}
		</div>
	);
}

import { Button } from "@portikus/ui";
import { useState } from "react";

/**
 * A copy button with its own always-mounted status line, so the result is
 * announced on pages that have no toast (SPEC.md section 25.8).
 */
export function CopyButton({
	label,
	text,
	copied,
	failed,
	testId,
}: {
	label: string;
	text: string;
	/** Said once the text is on the clipboard. */
	copied: string;
	/** Said when the browser refuses the clipboard. */
	failed: string;
	testId?: string;
}) {
	const [message, setMessage] = useState("");

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			setMessage(copied);
		} catch {
			setMessage(failed);
		}
	}

	return (
		<>
			<Button variant="secondary" data-testid={testId} onClick={() => void copy()}>
				{label}
			</Button>
			<span className="pk-text-compact text-ink-muted" role="status">
				{message}
			</span>
		</>
	);
}

import { Button, Dialog, DialogRoot, TextField } from "@portikus/ui";
import { useState } from "react";
import { graceText } from "./graceText.js";
import { announced } from "./SettingsTab.js";

/** The API's upper bound, a Postgres integer of seconds. */
const MAX_GRACE_SECONDS = 2147483647;

export const GRACE_ERROR = "Enter a number of minutes, 0 or more, or leave it blank.";

/**
 * Minutes as typed, in the seconds the API takes: null for blank (the site
 * setting), undefined when the entry is not a number of minutes.
 */
export function graceSeconds(text: string): number | null | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return null;
	if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
	const seconds = Math.round(Number(trimmed) * 60);
	return seconds > MAX_GRACE_SECONDS ? undefined : seconds;
}

/** The draft an override opens with: whole minutes, or up to two decimals. */
export function graceDraft(seconds: number | null): string {
	if (seconds === null) return "";
	return String(Math.round((seconds / 60) * 100) / 100);
}

/** One grace period in words: "10 minutes", or that it never stops on disconnect. */
export function graceValueText(seconds: number): string {
	return seconds === 0 ? "Never stops on disconnect" : graceText(seconds);
}

/** One account's disconnect grace, in minutes; the API still takes seconds (SPEC.md §6.4). */
export function GraceDialog({
	open,
	onOpenChange,
	current,
	siteSeconds,
	ownerName,
	pending,
	serverError,
	onSave,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The account's override in seconds, or null for the site setting. */
	current: number | null;
	/** The site setting, once loaded. */
	siteSeconds: number | null;
	ownerName: string;
	pending: boolean;
	serverError: string | null;
	onSave: (seconds: number | null) => void;
}) {
	const [draft, setDraft] = useState(() => graceDraft(current));
	const [error, setError] = useState<string | null>(null);

	function save() {
		const seconds = graceSeconds(draft);
		if (seconds === undefined) {
			setError(GRACE_ERROR);
			return;
		}
		setError(null);
		onSave(seconds);
	}

	const site =
		siteSeconds === null ? null : `Site setting: ${graceValueText(siteSeconds)}.`;

	return (
		<DialogRoot open={open} onOpenChange={onOpenChange}>
			<Dialog
				testId="grace-dialog"
				title={`Disconnect grace for ${ownerName}`}
				description="How long their workspace keeps running after their last browser tab closes. Leave it blank to use the site setting."
				footer={
					<>
						<Button onClick={() => onOpenChange(false)}>Cancel</Button>
						<Button
							variant="primary"
							data-testid="grace-dialog-save"
							loading={pending}
							onClick={save}
						>
							Save
						</Button>
					</>
				}
			>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						save();
					}}
				>
					<TextField
						id="grace-minutes"
						label="Disconnect grace (minutes)"
						inputMode="decimal"
						className="[&>input]:w-40"
						data-testid="grace-dialog-minutes"
						hint={[site, "0 keeps it running until it is stopped."]
							.filter(Boolean)
							.join(" ")}
						error={announced(error)}
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
					/>
					{/* Enter in the field saves. */}
					<button type="submit" hidden />
				</form>
				{!error && serverError ? (
					<p className="pk-text-compact m-0 mt-3 text-status-error" role="alert">
						{serverError}
					</p>
				) : null}
			</Dialog>
		</DialogRoot>
	);
}

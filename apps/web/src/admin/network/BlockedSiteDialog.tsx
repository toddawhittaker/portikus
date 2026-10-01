import { Button, Dialog, DialogRoot, TextField, useToast } from "@portikus/ui";
import { type KeyboardEvent, useState } from "react";
import { announced } from "../../common/announced.js";
import { entryLabelError, entryValueError } from "./EntryDialog.js";
import { egressErrorText, useEgressWrite } from "./queries.js";

/** What the dialog starts with: a blocked site to edit, or a new one. */
export interface BlockedSiteDraft {
	id?: string;
	value: string;
	label: string;
}

/** Add or edit one blocked site (ADR 0043). */
export function BlockedSiteDialog({
	draft,
	version,
	onClose,
}: {
	draft: BlockedSiteDraft;
	version: number;
	onClose: () => void;
}) {
	const write = useEgressWrite();
	const toast = useToast();
	const [value, setValue] = useState(draft.value);
	const [label, setLabel] = useState(draft.label);
	const [checked, setChecked] = useState(false);
	const editing = draft.id !== undefined;

	const valueError = checked ? entryValueError("host", value) : null;
	const labelError = checked ? entryLabelError(label) : null;

	function save() {
		setChecked(true);
		if (entryValueError("host", value) || entryLabelError(label)) return;
		const site = { version, value, label };
		write.mutate(
			draft.id === undefined
				? { kind: "block-add", site }
				: { kind: "block-edit", id: draft.id, site },
			{
				onSuccess: () => {
					toast.show({
						tone: "success",
						title: editing
							? "Blocked site saved"
							: `${value.trim().toLowerCase()} blocked`,
					});
					onClose();
				},
			},
		);
	}

	// Enter in a text field saves, as in a form.
	function saveOnEnter(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key !== "Enter") return;
		event.preventDefault();
		save();
	}

	return (
		<DialogRoot open onOpenChange={(open) => (open ? null : onClose())}>
			<Dialog
				testId="egress-block-dialog"
				title={editing ? "Edit blocked site" : "Block a site"}
				description="A host name also blocks every name under it: example.com covers www.example.com."
				footer={
					<>
						<Button onClick={onClose}>Cancel</Button>
						<Button
							variant="primary"
							data-testid="egress-block-save"
							loading={write.isPending}
							onClick={save}
						>
							{editing ? "Save" : "Block"}
						</Button>
					</>
				}
			>
				<div className="grid gap-4">
					<TextField
						id="egress-block-value"
						label="Host name"
						mono
						autoComplete="off"
						spellCheck={false}
						data-testid="egress-block-value"
						value={value}
						error={announced(valueError)}
						onKeyDown={saveOnEnter}
						onChange={(event) => setValue(event.target.value)}
					/>
					<TextField
						id="egress-block-label"
						label="Label (optional)"
						hint="Why it is blocked, such as a games site."
						data-testid="egress-block-label"
						value={label}
						error={valueError ? labelError : announced(labelError)}
						onKeyDown={saveOnEnter}
						onChange={(event) => setLabel(event.target.value)}
					/>
				</div>
				{write.isError ? (
					<p
						className="m-0 mt-3 text-[13px] text-status-error"
						role="alert"
						data-testid="egress-block-error"
					>
						{egressErrorText(write.error)}
					</p>
				) : null}
			</Dialog>
		</DialogRoot>
	);
}

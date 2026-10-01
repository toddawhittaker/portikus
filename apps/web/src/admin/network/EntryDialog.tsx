import {
	EGRESS_LIMITS,
	type EgressEntryKind,
	EgressHost,
	EgressLabel,
	EgressRange,
} from "@portikus/contracts";
import { Button, Dialog, DialogRoot, TextField, useToast } from "@portikus/ui";
import { type KeyboardEvent, useState } from "react";
import { announced } from "../../common/announced.js";
import { egressErrorText, useEgressWrite } from "./queries.js";

/** What the dialog starts with: an existing entry to edit, or a new one. */
export interface EntryDraft {
	id?: string;
	kind: EgressEntryKind;
	value: string;
	label: string;
}

/** The contracts' message for a value, or null when the API would take it. */
export function entryValueError(kind: EgressEntryKind, value: string): string | null {
	if (value.trim() === "") {
		return kind === "host" ? "Enter a host name." : "Enter an address range.";
	}
	const parsed = (kind === "host" ? EgressHost : EgressRange).safeParse(value);
	return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Not valid.");
}

export function entryLabelError(label: string): string | null {
	return EgressLabel.safeParse(label).success
		? null
		: `Keep the label to ${EGRESS_LIMITS.label} characters or fewer.`;
}

/** Add or edit one host name or address range (SPEC.md section 20.1). */
export function EntryDialog({
	draft,
	version,
	onClose,
	onSaved,
	returnFocusTo,
}: {
	draft: EntryDraft;
	version: number;
	onClose: () => void;
	onSaved: () => void;
	returnFocusTo: () => HTMLElement | null;
}) {
	const write = useEgressWrite();
	const toast = useToast();
	const [kind, setKind] = useState<EgressEntryKind>(draft.kind);
	const [value, setValue] = useState(draft.value);
	const [label, setLabel] = useState(draft.label);
	const [checked, setChecked] = useState(false);
	const editing = draft.id !== undefined;

	const valueError = checked ? entryValueError(kind, value) : null;
	const labelError = checked ? entryLabelError(label) : null;

	function save() {
		setChecked(true);
		if (entryValueError(kind, value) || entryLabelError(label)) return;
		const entry = { version, kind, value, label };
		write.mutate(
			draft.id === undefined
				? { kind: "add", entry }
				: { kind: "edit", id: draft.id, entry },
			{
				onSuccess: () => {
					toast.show({
						tone: "success",
						title: editing ? "Entry saved" : `${value.trim().toLowerCase()} added`,
					});
					onSaved();
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

	const title = editing ? "Edit entry" : "Allow a host or range";
	return (
		<DialogRoot open onOpenChange={(open) => (open ? null : onClose())}>
			<Dialog
				testId="egress-entry-dialog"
				returnFocusTo={returnFocusTo}
				title={title}
				description="A host name also allows every name under it: github.com covers api.github.com."
				footer={
					<>
						<Button onClick={onClose}>Cancel</Button>
						<Button
							variant="primary"
							data-testid="egress-entry-save"
							loading={write.isPending}
							onClick={save}
						>
							{editing ? "Save" : "Add"}
						</Button>
					</>
				}
			>
				<div className="grid gap-4">
					<fieldset className="m-0 grid gap-2 border-0 p-0">
						<legend className="mb-2 p-0 font-medium text-[13px] text-ink">Kind</legend>
						<label className="flex items-start gap-2 text-[13px]">
							<input
								type="radio"
								name="egress-kind"
								className="pk-focus-ring mt-0.5"
								checked={kind === "host"}
								data-testid="egress-kind-host"
								onChange={() => setKind("host")}
							/>
							<span>
								Host name
								<span className="block text-ink-muted">
									Such as api.example.edu. Use this for almost everything.
								</span>
							</span>
						</label>
						<label className="flex items-start gap-2 text-[13px]">
							<input
								type="radio"
								name="egress-kind"
								className="pk-focus-ring mt-0.5"
								checked={kind === "range"}
								data-testid="egress-kind-range"
								onChange={() => setKind("range")}
							/>
							<span>
								Address range
								<span className="block text-ink-muted">
									Such as 203.0.113.0/24, for a service reached by address, not by name.
								</span>
							</span>
						</label>
					</fieldset>
					<TextField
						id="egress-entry-value"
						label={kind === "host" ? "Host name" : "Address range"}
						mono
						autoComplete="off"
						spellCheck={false}
						data-testid="egress-entry-value"
						value={value}
						error={announced(valueError)}
						onKeyDown={saveOnEnter}
						onChange={(event) => setValue(event.target.value)}
					/>
					<TextField
						id="egress-entry-label"
						label="Label (optional)"
						hint="Why it is allowed, such as the course that needs it."
						data-testid="egress-entry-label"
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
						data-testid="egress-entry-error"
					>
						{egressErrorText(write.error)}
					</p>
				) : null}
			</Dialog>
		</DialogRoot>
	);
}

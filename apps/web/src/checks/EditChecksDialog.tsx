import {
	CHECKS_FILE_PATH,
	type CheckDefinition,
	MAX_CHECKS_PER_PROJECT,
	slugify,
} from "@portikus/contracts";
import { Button, Dialog, DialogRoot, IconButton, TextField } from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import "./checks.css";
import { useSaveChecks } from "./queries.js";

/** One row being edited. The id is derived from the name, as a slug. */
interface Draft {
	/** A stable key for React while the name is still being typed. */
	key: string;
	name: string;
	command: string;
}

let nextKey = 0;

function draftsOf(checks: CheckDefinition[]): Draft[] {
	return checks.map((check) => {
		nextKey += 1;
		return { key: `row-${nextKey}`, name: check.name, command: check.command };
	});
}

/** Rows that are complete enough to save, with a unique id each. */
export function definitionsOf(drafts: Draft[]): CheckDefinition[] {
	const seen = new Set<string>();
	const checks: CheckDefinition[] = [];
	for (const draft of drafts) {
		const name = draft.name.trim();
		const command = draft.command.trim();
		const id = slugify(name);
		if (name === "" || command === "" || id === "" || seen.has(id)) continue;
		seen.add(id);
		checks.push({ id, name, command });
	}
	return checks;
}

/**
 * Edit the project's checks and write them to `.portikus/checks.json`
 * (SPEC.md §18.1). The file is the student's own, so the dialog shows where
 * it is written rather than hiding it.
 */
export function EditChecksDialog({
	workspaceId,
	projectId,
	checks,
	onClose,
}: {
	workspaceId: string;
	projectId: string;
	checks: CheckDefinition[];
	onClose: () => void;
}) {
	const [drafts, setDrafts] = useState<Draft[]>(() =>
		checks.length > 0
			? draftsOf(checks)
			: [{ key: "row-0", name: "Tests", command: "npm test" }],
	);
	const save = useSaveChecks(workspaceId, projectId);
	const form = useRef<HTMLFormElement>(null);
	// After a row is removed, the index whose remove button takes focus.
	const [focusRow, setFocusRow] = useState<number | null>(null);

	useEffect(() => {
		if (focusRow === null || !form.current) return;
		const target =
			form.current.querySelector<HTMLElement>(
				`[data-testid="check-remove-${focusRow}"]`,
			) ?? form.current.querySelector<HTMLElement>('[data-testid="check-add"]');
		target?.focus();
		setFocusRow(null);
	}, [focusRow]);

	function update(key: string, patch: Partial<Draft>) {
		setDrafts((rows) =>
			rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
		);
	}

	function addRow() {
		nextKey += 1;
		setDrafts((rows) => [...rows, { key: `row-${nextKey}`, name: "", command: "" }]);
	}

	function submit() {
		if (save.isPending) return;
		save.mutate(definitionsOf(drafts), { onSuccess: onClose });
	}

	return (
		<DialogRoot open onOpenChange={(open) => !open && onClose()}>
			<Dialog
				testId="dialog-edit-checks"
				size="lg"
				title="Edit checks"
				description={`Saved in the project, as ${CHECKS_FILE_PATH}.`}
				onClose={onClose}
				footer={
					<>
						<Button variant="secondary" onClick={onClose}>
							Cancel
						</Button>
						<Button
							data-testid="dialog-confirm"
							variant="primary"
							loading={save.isPending}
							disabled={save.isPending}
							onClick={submit}
						>
							{save.isPending ? "Saving…" : "Save checks"}
						</Button>
					</>
				}
			>
				<form
					ref={form}
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					{drafts.map((draft, index) => (
						<div
							className="pk-check-edit-row"
							key={draft.key}
							data-testid={`check-edit-row-${index}`}
						>
							<TextField
								id={`check-name-${draft.key}`}
								data-testid={`check-name-${index}`}
								label={
									<>
										<span className="pk-visually-hidden">Check {index + 1} </span>
										Name
									</>
								}
								value={draft.name}
								autoComplete="off"
								spellCheck={false}
								onChange={(event) => update(draft.key, { name: event.target.value })}
							/>
							<TextField
								id={`check-command-${draft.key}`}
								data-testid={`check-command-${index}`}
								label={
									<>
										<span className="pk-visually-hidden">Check {index + 1} </span>
										Command
									</>
								}
								mono
								value={draft.command}
								autoComplete="off"
								spellCheck={false}
								onChange={(event) => update(draft.key, { command: event.target.value })}
							/>
							<IconButton
								icon="trash"
								label={`Remove check ${index + 1}`}
								data-testid={`check-remove-${index}`}
								onClick={() => {
									setDrafts((rows) => rows.filter((row) => row.key !== draft.key));
									// The row below moves up into this place; the last row falls back.
									setFocusRow(Math.min(index, drafts.length - 2));
								}}
							/>
						</div>
					))}
					<Button
						variant="secondary"
						data-testid="check-add"
						disabled={drafts.length >= MAX_CHECKS_PER_PROJECT}
						onClick={addRow}
					>
						Add a check
					</Button>
					<button type="submit" className="hidden" tabIndex={-1} aria-hidden="true" />
				</form>
				{save.error && (
					<p
						className="pk-error mt-3 text-[12px] leading-4 text-status-error"
						role="alert"
						data-testid="checks-save-error"
					>
						{save.error.message}
					</p>
				)}
			</Dialog>
		</DialogRoot>
	);
}

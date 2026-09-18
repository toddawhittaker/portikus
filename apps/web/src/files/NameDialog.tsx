/**
 * Ask for one name: a new file, a new folder, or a rename (SPEC.md §11.2).
 * The name is checked here as well as in the agent, so an obviously bad one
 * never becomes a request.
 */
import { Button, Dialog, DialogRoot, TextField } from "@portikus/ui";
import { useState } from "react";
import { nameError } from "./paths.js";

export interface NameDialogProps {
	title: string;
	description?: string;
	label: string;
	confirmLabel: string;
	initial?: string;
	pending?: boolean;
	onSubmit: (name: string) => void;
	onClose: () => void;
}

export function NameDialog({
	title,
	description,
	label,
	confirmLabel,
	initial = "",
	pending,
	onSubmit,
	onClose,
}: NameDialogProps) {
	const [name, setName] = useState(initial);
	const [touched, setTouched] = useState(false);
	const error = nameError(name);

	function submit() {
		setTouched(true);
		if (error || pending) return;
		onSubmit(name.trim());
	}

	return (
		<DialogRoot open onOpenChange={(open) => !open && onClose()}>
			<Dialog
				testId="dialog-file-name"
				title={title}
				description={description}
				onClose={onClose}
				footer={
					<>
						<Button variant="secondary" onClick={onClose}>
							Cancel
						</Button>
						<Button
							data-testid="dialog-confirm"
							variant="primary"
							loading={pending}
							disabled={error !== null || pending}
							onClick={submit}
						>
							{confirmLabel}
						</Button>
					</>
				}
			>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<TextField
						id="field-file-name"
						data-testid="field-file-name"
						label={label}
						value={name}
						autoFocus
						autoComplete="off"
						spellCheck={false}
						mono
						onChange={(event) => setName(event.target.value)}
						error={touched && error ? error : undefined}
					/>
					<button type="submit" className="hidden" tabIndex={-1} aria-hidden="true" />
				</form>
			</Dialog>
		</DialogRoot>
	);
}

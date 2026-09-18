/**
 * The student's own editor settings (issue #159, SPEC.md §13.5): auto-save on
 * or off, how long after the last keystroke it writes, and word wrap. They are
 * kept on the server per user, so they follow the student between browsers.
 */
import {
	EDITOR_SETTINGS_DEFAULTS,
	type UpdateEditorSettingsRequest,
} from "@portikus/contracts";
import { Button, Checkbox, Dialog, DialogRoot, TextField } from "@portikus/ui";
import { useState } from "react";
import {
	useEditorSettings,
	useUpdateEditorSettings,
} from "../editor/settingsQueries.js";

/** The delay a student may ask for, in seconds (contracts/settings.ts). */
const MIN_DELAY = 1;
const MAX_DELAY = 60;

export function EditorSettingsDialog({ onClose }: { onClose: () => void }) {
	const settings = useEditorSettings();
	const update = useUpdateEditorSettings();
	// While the settings are still loading the dialog shows the defaults, the
	// same values the editor is using until they arrive.
	const current = settings.data ?? EDITOR_SETTINGS_DEFAULTS;

	// The draft is only what the student has touched, so a setting they left
	// alone still shows what the server sent once it arrives.
	const [draft, setDraft] = useState<UpdateEditorSettingsRequest>({});
	const [delayText, setDelayText] = useState<string | null>(null);

	const autoSave = draft.autoSave ?? current.autoSave;
	const wordWrap = draft.wordWrap ?? current.wordWrap;
	const delay =
		delayText ?? String(draft.autoSaveDelaySeconds ?? current.autoSaveDelaySeconds);

	const parsedDelay = /^\d+$/.test(delay.trim()) ? Number(delay.trim()) : null;
	const delayError =
		parsedDelay === null || parsedDelay < MIN_DELAY || parsedDelay > MAX_DELAY
			? `Give a whole number of seconds between ${MIN_DELAY} and ${MAX_DELAY}.`
			: null;

	function save() {
		if (delayError !== null || parsedDelay === null || update.isPending) return;
		const body: UpdateEditorSettingsRequest = {
			autoSave,
			autoSaveDelaySeconds: parsedDelay,
			wordWrap,
		};
		update.mutate(body, { onSuccess: onClose });
	}

	return (
		<DialogRoot open onOpenChange={(open) => !open && onClose()}>
			<Dialog
				testId="dialog-editor-settings"
				title="Editor settings"
				description="These follow you to any browser you sign in from."
				onClose={onClose}
				footer={
					<>
						<Button variant="secondary" onClick={onClose}>
							Cancel
						</Button>
						<Button
							data-testid="editor-settings-save"
							variant="primary"
							loading={update.isPending}
							disabled={delayError !== null || update.isPending}
							onClick={save}
						>
							Save
						</Button>
					</>
				}
			>
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						save();
					}}
				>
					<Checkbox
						label="Auto-save"
						description="Write the file a few seconds after you stop typing. Ctrl+S always saves now, whether this is on or off."
						checked={autoSave}
						onChange={(event) =>
							setDraft((current) => ({ ...current, autoSave: event.target.checked }))
						}
						className="pk-setting-autosave"
					/>
					<TextField
						id="editor-autosave-delay"
						data-testid="editor-settings-delay"
						label="Auto-save delay in seconds"
						className="w-48"
						inputMode="numeric"
						value={delay}
						disabled={!autoSave}
						error={delayError}
						onChange={(event) => setDelayText(event.target.value)}
					/>
					<Checkbox
						label="Word wrap"
						description="Wrap long lines instead of scrolling sideways."
						checked={wordWrap}
						onChange={(event) =>
							setDraft((current) => ({ ...current, wordWrap: event.target.checked }))
						}
						className="pk-setting-wordwrap"
					/>
					<button type="submit" className="hidden" tabIndex={-1} aria-hidden="true" />
				</form>
				{update.isError ? (
					<p
						className="pk-text-body mt-3 text-status-error"
						data-testid="editor-settings-error"
					>
						{update.error instanceof Error
							? update.error.message
							: "The settings were not saved."}
					</p>
				) : null}
			</Dialog>
		</DialogRoot>
	);
}

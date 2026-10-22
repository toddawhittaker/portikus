import {
	DEFAULT_ACCEPTABLE_USE_TEXT,
	MAX_ACCEPTABLE_USE_LENGTH,
} from "@portikus/contracts";
import {
	Button,
	CONTROL_CLASS,
	ConfirmDialog,
	ConfirmDialogRoot,
	FIELD_CLASS,
	FieldMessages,
	HINT_CLASS,
	LABEL_CLASS,
	Skeleton,
} from "@portikus/ui";
import { type FormEvent, useState } from "react";
import { usePlatformSettings } from "../queries.js";
import { useDraft } from "./draft.js";
import { footerState, SaveFooter } from "./SaveFooter.js";
import { SectionCard, SectionNotLoaded } from "./SectionCard.js";
import { NotSaved } from "./SettingRow.js";
import { useFocusFirstError, useSaveSettings } from "./save.js";
import { SECTIONS } from "./sections.js";
import { useReportUnsaved } from "./unsaved.js";

const SECTION = SECTIONS.aup;
const DESCRIPTION =
	"The statement everyone, you included, accepts before using Portikus. Plain text; a blank line starts a new paragraph.";
const FIELD = "aup-text";
const numbers = new Intl.NumberFormat("en");

/** What is wrong with a statement before it is sent; null when it can be saved. */
function acceptableUseError(text: string): string | null {
	if (text.trim() === "") {
		return "Enter the statement, or restore the built-in text.";
	}
	if (text.length > MAX_ACCEPTABLE_USE_LENGTH) {
		return `The statement can be at most ${numbers.format(MAX_ACCEPTABLE_USE_LENGTH)} characters.`;
	}
	return null;
}

const focusField = () => FIELD;

/**
 * The acceptable-use statement (ADR 0032). Saving a changed statement asks
 * everyone to accept it again. "Restore built-in text…" is the one action on
 * the page that saves without the section's Save, after it asks.
 */
export function AupSection() {
	const settings = usePlatformSettings();
	const saved = settings.data
		? { text: settings.data.acceptableUseText ?? DEFAULT_ACCEPTABLE_USE_TEXT }
		: undefined;
	const draft = useDraft(saved);
	const save = useSaveSettings();
	const restore = useSaveSettings();
	const [confirming, setConfirming] = useState(false);
	const focusFirstError = useFocusFirstError(draft.errors, focusField);
	useReportUnsaved(SECTION.title, draft.changed.length);

	function submit(event: FormEvent) {
		event.preventDefault();
		if (draft.changed.length === 0 || save.pending) return;
		const text = draft.value("text") ?? "";
		const found = acceptableUseError(text);
		if (found) {
			draft.refuse({ text: found });
			focusFirstError();
			return;
		}
		save.send({ acceptableUseText: text }, draft);
	}

	if (!saved || !settings.data) {
		return (
			<SectionNotLoaded
				section={SECTION}
				description={DESCRIPTION}
				read={settings}
				announce={false}
				skeleton={
					<div className="grid gap-1.5">
						<Skeleton variant="block" width="5rem" height={14} />
						<Skeleton variant="block" height="19rem" />
					</div>
				}
			/>
		);
	}

	const builtIn = settings.data.acceptableUseText === null;
	const text = draft.value("text") ?? "";
	const error = draft.errors.text;
	return (
		<SectionCard section={SECTION} description={DESCRIPTION}>
			<form className="grid min-w-0 gap-5" noValidate onSubmit={submit}>
				<div className={FIELD_CLASS}>
					<label className={LABEL_CLASS} htmlFor={FIELD}>
						Statement
					</label>
					<textarea
						id={FIELD}
						className={`${CONTROL_CLASS} h-auto min-h-[19rem] resize-y py-2 leading-[1.45] aria-[invalid=true]:border-status-error`}
						data-testid={FIELD}
						rows={12}
						value={text}
						aria-invalid={error ? true : undefined}
						aria-describedby={[
							draft.isChanged("text") ? `${FIELD}-was` : null,
							error ? `${FIELD}-err` : null,
							`${FIELD}-hint`,
						]
							.filter(Boolean)
							.join(" ")}
						onChange={(event) => draft.edit("text", event.target.value)}
					/>
					{draft.isChanged("text") ? <NotSaved id={`${FIELD}-was`} was={null} /> : null}
					<FieldMessages id={FIELD} error={error} />
					<p className={HINT_CLASS} id={`${FIELD}-hint`}>
						Version {settings.data.acceptableUseVersion}
						{builtIn ? ", the built-in text" : ""}. {numbers.format(text.length)} of{" "}
						{numbers.format(MAX_ACCEPTABLE_USE_LENGTH)} characters.
					</p>
				</div>
				<SaveFooter
					id={SECTION.id}
					count={draft.changed.length}
					state={footerState({
						count: draft.changed.length,
						firstError: error ? "the statement" : null,
						failure: draft.failure,
						justSaved: draft.justSaved,
					})}
					note="Saving a changed statement asks everyone to accept it again at their next page load."
					saveLabel="Save and ask everyone to accept"
					pending={save.pending}
					onDiscard={draft.discard}
					extra={
						<Button
							data-testid="aup-restore"
							loading={restore.pending}
							aria-describedby={`${SECTION.id}-note`}
							onClick={() => setConfirming(true)}
						>
							Restore built-in text…
						</Button>
					}
				/>
			</form>
			<ConfirmDialogRoot open={confirming} onOpenChange={setConfirming}>
				<ConfirmDialog
					id="aup-restore-confirm"
					testId="aup-restore-dialog"
					title="Restore the built-in text?"
					description={`The statement goes back to the built-in text and is saved now${draft.isChanged("text") ? ", and your unsaved edits are lost" : ""}. Everyone is asked to accept it again at their next page load.`}
					confirmLabel="Restore built-in text"
					cancelLabel="Keep this statement"
					onConfirm={() => {
						setConfirming(false);
						restore.send({ acceptableUseText: null }, draft);
					}}
					onCancel={() => setConfirming(false)}
				/>
			</ConfirmDialogRoot>
		</SectionCard>
	);
}

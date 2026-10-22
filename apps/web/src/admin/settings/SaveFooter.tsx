import { Button } from "@portikus/ui";
import { type ReactNode, useRef } from "react";
import { unsavedText } from "./unsaved.js";

/** What a section's footer says, worked out from its draft. */
export function footerState({
	count,
	firstError,
	failure,
	justSaved,
}: {
	count: number;
	/** The label of the first field that needs fixing, if any. */
	firstError: string | null;
	failure: string | null;
	justSaved: boolean;
}): { text: string; strong: boolean } {
	if (firstError) {
		return {
			text: `Not saved. ${unsavedText(count)}; fix ${firstError} and save again.`,
			strong: true,
		};
	}
	if (failure) return { text: `Not saved. ${failure}`, strong: true };
	if (count > 0) return { text: unsavedText(count), strong: true };
	if (justSaved) return { text: "Saved.", strong: false };
	return { text: "No unsaved changes.", strong: false };
}

/**
 * The one save row every section ends with: what is unsaved on the left,
 * Discard changes and the section's own Save on the right. Save is the
 * primary button only while there is something to save.
 */
export function SaveFooter({
	id,
	state,
	count,
	saveLabel,
	pending,
	note,
	extra,
	busy,
	onDiscard,
	children,
}: {
	id: string;
	state: { text: string; strong: boolean };
	count: number;
	saveLabel: string;
	pending: boolean;
	/** One line on what saving does, read as the Save button's description. */
	note?: string;
	/** Another action, placed before Discard changes. */
	extra?: ReactNode;
	/** Why Save cannot act yet; it stays focusable and says so. */
	busy?: string;
	onDiscard: () => void;
	/** More status under the state, such as the alerts job's line. */
	children?: ReactNode;
}) {
	const save = useRef<HTMLButtonElement>(null);
	const noteId = busy ? `${id}-busy` : note ? `${id}-note` : undefined;
	return (
		<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
			<div className="grid min-w-0 flex-[1_1_16rem] gap-1 text-[length:var(--pk-font)]">
				{/* Always mounted, so each change is read out (SPEC.md section 25.8). */}
				<p
					role="status"
					className={`m-0 [overflow-wrap:anywhere] ${state.strong ? "font-semibold text-ink" : "pk-muted"}`}
					data-testid={`${id}-state`}
				>
					{state.text}
				</p>
				{busy || note ? (
					<p className="pk-muted m-0" id={noteId}>
						{busy ?? note}
					</p>
				) : null}
				{children}
			</div>
			<div className="pk-actions">
				{extra}
				{count > 0 ? (
					<Button
						data-testid={`${id}-discard`}
						onClick={() => {
							onDiscard();
							// The button goes with the changes; Save stays.
							save.current?.focus();
						}}
					>
						Discard changes
					</Button>
				) : null}
				<Button
					ref={save}
					type="submit"
					variant={count > 0 ? "primary" : "secondary"}
					data-testid={`${id}-save`}
					loading={pending}
					aria-disabled={busy ? true : undefined}
					aria-describedby={noteId}
				>
					{saveLabel}
				</Button>
			</div>
		</div>
	);
}

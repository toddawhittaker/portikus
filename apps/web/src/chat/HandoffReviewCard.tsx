/**
 * The handoff note the agent wrote, for the student to review before the
 * chat starts fresh from it (SPEC.md §10.8). Continue starts the new
 * conversation with the note; Edit changes the note, rewriting its file;
 * Cancel keeps this conversation and the saved note.
 *
 * The keyboard moves into the card as it opens, and Escape is Cancel. While
 * editing, Escape leaves the edit instead, as the deny reason field does
 * (SPEC.md §25.8).
 */
import { type HandoffReview, MAX_HANDOFF_NOTE_CHARS } from "@portikus/contracts";
import { Button, CONTROL_CLASS, LABEL_CLASS } from "@portikus/ui";
import { useEffect, useId, useRef, useState } from "react";
import { NeedsInputTag } from "./NeedsInputTag.js";
import { PlanText } from "./PermissionCard.js";
import "./handoff.css";
import "./permissions.css";

const NOT_SENT =
	"That was not sent because the chat is not connected. Wait for it to reconnect, then try again.";

export interface HandoffReviewCardProps {
	review: HandoffReview;
	takeFocus: () => boolean;
	/** Each returns false when the message could not be sent. */
	onContinue: () => boolean;
	onEdit: (markdown: string) => boolean;
	onCancel: () => boolean;
}

export function HandoffReviewCard({
	review,
	takeFocus,
	onContinue,
	onEdit,
	onCancel,
}: HandoffReviewCardProps) {
	const titleId = useId();
	const fieldId = useId();
	const actions = useRef<HTMLDivElement | null>(null);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(review.markdown);
	const [continuing, setContinuing] = useState(false);
	const [error, setError] = useState("");

	// biome-ignore lint/correctness/useExhaustiveDependencies: only as the card opens
	useEffect(() => {
		if (takeFocus()) actions.current?.querySelector<HTMLElement>("button")?.focus();
	}, []);

	function sent(ok: boolean): boolean {
		setError(ok ? "" : NOT_SENT);
		return ok;
	}

	function backToNote() {
		setEditing(false);
		requestAnimationFrame(() =>
			actions.current
				?.querySelector<HTMLElement>('[data-testid="chat-handoff-edit"]')
				?.focus(),
		);
	}

	return (
		<section
			className="pk-chat-card pk-chat-handoff-card"
			aria-labelledby={titleId}
			data-testid="chat-handoff-card"
			onKeyDown={(event) => {
				if (event.key !== "Escape" || continuing) return;
				event.preventDefault();
				event.stopPropagation();
				if (editing) backToNote();
				else sent(onCancel());
			}}
		>
			<header className="pk-chat-card-head">
				<h2 id={titleId} className="pk-text-heading">
					Review the handoff note
				</h2>
				<NeedsInputTag />
			</header>
			<p className="pk-chat-card-subtitle">
				Saved at <code data-testid="chat-handoff-path">{review.path}</code>. Continue
				starts a fresh conversation that begins with this note.
			</p>
			{editing ? (
				<form
					className="pk-chat-handoff-edit"
					onSubmit={(event) => {
						event.preventDefault();
						if (sent(onEdit(draft))) backToNote();
					}}
				>
					<label htmlFor={fieldId} className={LABEL_CLASS}>
						Handoff note
					</label>
					<textarea
						id={fieldId}
						className={`${CONTROL_CLASS} pk-chat-handoff-text`}
						value={draft}
						maxLength={MAX_HANDOFF_NOTE_CHARS}
						rows={12}
						// biome-ignore lint/a11y/noAutofocus: the student asked to edit this text
						autoFocus
						data-testid="chat-handoff-text"
						onChange={(event) => setDraft(event.target.value)}
					/>
					<div className="pk-chat-card-actions">
						<Button type="submit" variant="primary" data-testid="chat-handoff-save">
							Save the note
						</Button>
						<Button
							type="button"
							variant="secondary"
							data-testid="chat-handoff-discard"
							onClick={backToNote}
						>
							Discard changes
						</Button>
					</div>
				</form>
			) : (
				<PlanText text={review.markdown} testId="chat-handoff-note" />
			)}
			<p className="pk-chat-card-error" role="alert">
				{error}
			</p>
			<div ref={actions} className="pk-chat-card-actions" hidden={editing}>
				<Button
					variant="primary"
					loading={continuing}
					data-testid="chat-handoff-continue"
					onClick={() => {
						if (!continuing && sent(onContinue())) setContinuing(true);
					}}
				>
					Continue
				</Button>
				<Button
					variant="secondary"
					aria-disabled={continuing ? true : undefined}
					data-testid="chat-handoff-edit"
					onClick={() => {
						if (continuing) return;
						setDraft(review.markdown);
						setEditing(true);
					}}
				>
					Edit
				</Button>
				<Button
					variant="secondary"
					aria-disabled={continuing ? true : undefined}
					aria-keyshortcuts="Escape"
					data-testid="chat-handoff-cancel"
					onClick={() => {
						if (!continuing) sent(onCancel());
					}}
				>
					Cancel
				</Button>
			</div>
		</section>
	);
}

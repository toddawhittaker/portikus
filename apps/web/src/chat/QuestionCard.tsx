/**
 * Claude's AskUserQuestion, one question at a time (SPEC.md §10.8): the
 * question with a pager, its options as full-width rows with any preview
 * inside the row, "Other" last, and a quiet "Add a note". Skip declines a
 * question, Skip all the whole card; a skipped question is sent without an
 * answer. Only the body scrolls, so the buttons stay in view. Enter on an
 * option or Ctrl+Enter anywhere goes on; Enter in a note adds a line.
 * Focus moves only with the student's own action inside the card, and never
 * scrolls anything but the card (SPEC.md §25.8).
 */
import type { ChatOpenCard, ChatQuestion } from "@portikus/contracts";
import { Button, IconButton, ShortcutHint } from "@portikus/ui";
import {
	type FormEvent,
	type KeyboardEvent,
	type RefObject,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { NeedsInputTag } from "./NeedsInputTag.js";
import {
	buildQuestionAnswer,
	draftAnswer,
	emptyDraft,
	isSettled,
	type QuestionDraft,
} from "./questionAnswer.js";
import { waitingText } from "./waiting.js";
import "./question-card.css";

type QuestionCardData = Extract<ChatOpenCard, { type: "question" }>;

export interface QuestionCardProps {
	card: QuestionCardData;
	/** False when the answer could not be sent. */
	onAnswer: (
		answers: Record<string, string>,
		notes?: Record<string, string>,
	) => boolean;
	/** Whether the card may take the keyboard as it appears. */
	takeFocus: () => boolean;
	/** Cards waiting behind this one. */
	waiting: number;
}

const NOT_SENT =
	"Your answer was not sent because the chat is not connected. Wait for it to reconnect, then send again.";
const PICK_FIRST =
	"Pick an answer or write your own under Other, or skip this question.";

/** Scroll only `box` so `node` is in view; focus() would scroll every ancestor too. */
function revealIn(box: HTMLElement | null, node: HTMLElement | null) {
	if (!box || !node) return;
	const outer = box.getBoundingClientRect();
	const inner = node.getBoundingClientRect();
	if (inner.top < outer.top) box.scrollTop -= outer.top - inner.top;
	else if (inner.bottom > outer.bottom) box.scrollTop += inner.bottom - outer.bottom;
}

export function QuestionCard({
	card,
	onAnswer,
	takeFocus,
	waiting,
}: QuestionCardProps) {
	const id = useId();
	const form = useRef<HTMLFormElement | null>(null);
	const body = useRef<HTMLDivElement | null>(null);
	const [drafts, setDrafts] = useState<QuestionDraft[]>(() =>
		card.questions.map(() => emptyDraft),
	);
	const [page, setPage] = useState(0);
	/** The furthest question reached, so the forward arrow can return to it. */
	const [reached, setReached] = useState(0);
	const [error, setError] = useState("");
	const [sent, setSent] = useState(false);
	/** Set by the student's own move to another question, so focus follows it. */
	const moved = useRef(false);
	const count = card.questions.length;
	const question = card.questions[page] as ChatQuestion;
	const draft = drafts[page] ?? emptyDraft;
	const last = page === count - 1;
	const answered = draftAnswer(question, draft) !== "";
	/** Why the forward arrow is unavailable, as the id of its reason, or null when it works. */
	const forwardWhy = !isSettled(question, draft)
		? `${id}-why`
		: last
			? `${id}-last`
			: page >= reached
				? `${id}-ahead`
				: null;

	/** Focus the current question's chosen option, or its first. */
	function focusOption() {
		const options = body.current?.querySelectorAll<HTMLInputElement>(
			"input[type=radio], input[type=checkbox]",
		);
		const target =
			Array.from(options ?? []).find((input) => input.checked) ?? options?.[0];
		target?.focus({ preventScroll: true });
		revealIn(body.current, target?.closest("li") ?? null);
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: only as the card first appears
	useEffect(() => {
		if (takeFocus()) focusOption();
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the question changes
	useEffect(() => {
		if (body.current) body.current.scrollTop = 0;
		if (!moved.current) return;
		moved.current = false;
		focusOption();
	}, [page]);

	function update(change: Partial<QuestionDraft>) {
		setDrafts((all) =>
			all.map((one, at) => (at === page ? { ...one, ...change, skipped: false } : one)),
		);
		setError("");
	}

	function goTo(next: number) {
		moved.current = true;
		setError("");
		setPage(next);
		setReached((was) => Math.max(was, next));
	}

	function send(answers: Record<string, string>, notes?: Record<string, string>) {
		if (sent) return;
		if (!onAnswer(answers, notes)) {
			setError(NOT_SENT);
			return;
		}
		setSent(true);
	}

	function finish(all: QuestionDraft[]) {
		const answer = buildQuestionAnswer(card.questions, all);
		if (!answer.ok) {
			// Only a question reopened and cleared can be left unsettled.
			setError(PICK_FIRST);
			goTo(answer.missing[0] ?? 0);
			return;
		}
		send(answer.answers, answer.notes);
	}

	function advance(event?: FormEvent) {
		event?.preventDefault();
		if (sent) return;
		if (!answered) {
			setError(PICK_FIRST);
			return;
		}
		if (last) finish(drafts);
		else goTo(page + 1);
	}

	function skip() {
		if (sent) return;
		const all = drafts.map((one, at) =>
			at === page ? { ...one, skipped: true } : one,
		);
		setDrafts(all);
		if (last) finish(all);
		else goTo(page + 1);
	}

	function onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
		const target = event.target as HTMLElement;
		const box =
			target instanceof HTMLInputElement &&
			(target.type === "radio" || target.type === "checkbox");
		// Checkboxes have no arrow keys of their own; radios move and pick natively.
		if (
			box &&
			(target as HTMLInputElement).type === "checkbox" &&
			(event.key === "ArrowDown" || event.key === "ArrowUp")
		) {
			event.preventDefault();
			const boxes = Array.from(
				body.current?.querySelectorAll<HTMLInputElement>("input[type=checkbox]") ?? [],
			);
			const at = boxes.indexOf(target as HTMLInputElement);
			const next = boxes[at + (event.key === "ArrowDown" ? 1 : -1)];
			next?.focus({ preventScroll: true });
			revealIn(body.current, next?.closest("li") ?? null);
			return;
		}
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing)
			return;
		// Ctrl+Enter goes on from anywhere, a note included; Enter does from an option.
		if (event.ctrlKey || event.metaKey || box) {
			event.preventDefault();
			advance();
		}
	}

	return (
		<section
			className="pk-chat-card pk-chat-qcard"
			aria-label={count === 1 ? "Claude's question" : "Claude's questions"}
			data-testid="chat-question-card"
		>
			<form
				ref={form}
				className="pk-chat-qform"
				noValidate={true}
				onSubmit={advance}
				onKeyDown={onKeyDown}
			>
				<header className="pk-chat-qhead">
					<div className="pk-chat-qbar">
						<NeedsInputTag />
						{question.header ? (
							<span className="pk-chat-chip pk-text-caption">{question.header}</span>
						) : null}
						{count > 1 ? (
							<div className="pk-chat-pager">
								<p className="pk-chat-qposition" data-testid="chat-question-position">
									{page + 1} of {count}
								</p>
								<IconButton
									icon="arrow-left"
									label="Previous question"
									size="sm"
									aria-disabled={page === 0 || undefined}
									aria-describedby={page === 0 ? `${id}-first` : undefined}
									onClick={() => page > 0 && goTo(page - 1)}
								/>
								<IconButton
									icon="arrow-right"
									label="Next question"
									size="sm"
									aria-disabled={forwardWhy !== null || undefined}
									aria-describedby={forwardWhy ?? undefined}
									onClick={() => forwardWhy === null && goTo(page + 1)}
								/>
								<span id={`${id}-first`} hidden={true}>
									This is the first question.
								</span>
								<span id={`${id}-last`} hidden={true}>
									This is the last question.
								</span>
								<span id={`${id}-ahead`} hidden={true}>
									Use Next to go on.
								</span>
							</div>
						) : null}
					</div>
					<h2 id={`${id}-q`} className="pk-chat-qtext">
						{question.question}
					</h2>
					{question.multiSelect ? (
						<p id={`${id}-how`} className="pk-chat-muted pk-chat-qhow">
							Pick any that apply
						</p>
					) : null}
				</header>
				<div ref={body} className="pk-chat-qbody">
					<QuestionFields
						// A fresh set of fields per question, so each starts with its note closed.
						key={page}
						id={id}
						question={question}
						draft={draft}
						onChange={update}
						last={last}
						bodyRef={body}
					/>
				</div>
				<p className="pk-chat-card-error" role="alert">
					{error}
				</p>
				<p className="sr-only" aria-live="polite">
					{count > 1 ? `Question ${page + 1} of ${count}: ${question.question}` : ""}
				</p>
				<footer className="pk-chat-qfoot">
					{count > 1 ? (
						<Button
							variant="quiet"
							size="sm"
							data-testid="chat-question-skip-all"
							onClick={() => send({})}
						>
							Skip all
						</Button>
					) : null}
					{waiting > 0 ? (
						<p className="pk-chat-card-waiting" data-testid="chat-cards-waiting">
							{waitingText(waiting)}
						</p>
					) : null}
					<span className="pk-chat-qfoot-end">
						<Button size="sm" data-testid="chat-question-skip" onClick={skip}>
							Skip
						</Button>
						<Button
							type="submit"
							variant="primary"
							size="sm"
							loading={sent}
							aria-disabled={!answered || undefined}
							aria-describedby={answered ? undefined : `${id}-why`}
							aria-keyshortcuts="Control+Enter"
							data-testid="chat-question-next"
						>
							{last ? "Submit" : "Next"}
							<span aria-hidden={true}>
								<ShortcutHint keys={["Ctrl", "Enter"]} plain={true} />
							</span>
						</Button>
					</span>
					<span id={`${id}-why`} hidden={true}>
						{PICK_FIRST}
					</span>
				</footer>
			</form>
		</section>
	);
}

function QuestionFields({
	id,
	question,
	draft,
	onChange,
	last,
	bodyRef,
}: {
	id: string;
	question: ChatQuestion;
	draft: QuestionDraft;
	onChange: (change: Partial<QuestionDraft>) => void;
	last: boolean;
	bodyRef: RefObject<HTMLDivElement | null>;
}) {
	const otherField = useRef<HTMLInputElement | null>(null);
	const notesField = useRef<HTMLTextAreaElement | null>(null);
	const [noting, setNoting] = useState(draft.notes !== "");
	const single = !question.multiSelect;
	const type = single ? "radio" : "checkbox";
	const name = `${id}-pick`;

	function reveal(node: HTMLElement | null) {
		node?.focus({ preventScroll: true });
		revealIn(bodyRef.current, node);
	}

	// "Add a note" goes away with its own click, so the new field takes the keyboard.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the note opens
	useEffect(() => {
		if (noting && draft.notes === "") reveal(notesField.current);
	}, [noting]);

	function toggle(label: string, on: boolean) {
		if (single) onChange({ picked: [label], otherPicked: false });
		else
			onChange({
				picked: on
					? question.options
							.map((o) => o.label)
							.filter((l) => l === label || draft.picked.includes(l))
					: draft.picked.filter((l) => l !== label),
			});
	}

	return (
		<fieldset
			className="pk-chat-question"
			data-testid="chat-question"
			aria-labelledby={`${id}-q`}
			aria-describedby={single ? undefined : `${id}-how`}
		>
			<ul className="pk-chat-options">
				{question.options.map((option, at) => {
					const previewId =
						option.preview !== undefined ? `${id}-preview-${at}` : undefined;
					return (
						<li key={option.label} className="pk-chat-option">
							<OptionRow
								type={type}
								name={name}
								label={option.label}
								description={option.description}
								describedBy={previewId}
								checked={
									single
										? !draft.otherPicked && draft.picked[0] === option.label
										: draft.picked.includes(option.label)
								}
								onChange={(on) => toggle(option.label, on)}
							/>
							{previewId ? (
								<pre
									id={previewId}
									className="pk-chat-code pk-chat-option-preview"
									// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box must be reachable by keyboard
									tabIndex={0}
									data-testid="chat-question-preview"
								>
									{option.preview}
								</pre>
							) : null}
						</li>
					);
				})}
				<li className="pk-chat-option">
					<OptionRow
						type={type}
						name={name}
						label="Other"
						checked={draft.otherPicked}
						onChange={(on, byPointer) => {
							onChange(
								single ? { picked: [], otherPicked: true } : { otherPicked: on },
							);
							// A click means "let me type"; an arrow key is still moving through the list.
							if (on && byPointer) {
								requestAnimationFrame(() => reveal(otherField.current));
							}
						}}
					/>
					{draft.otherPicked ? (
						<input
							ref={otherField}
							className="pk-chat-input pk-chat-other-input pk-focus-ring"
							type="text"
							aria-label="Your own answer"
							value={draft.other}
							placeholder="Write your own answer"
							data-testid="chat-question-other"
							onChange={(event) => onChange({ other: event.target.value })}
						/>
					) : null}
				</li>
			</ul>
			{noting ? (
				<div className="pk-chat-note">
					<label className="pk-chat-field-label" htmlFor={`${id}-notes`}>
						Note <span className="pk-chat-muted">(optional)</span>
					</label>
					<textarea
						ref={notesField}
						id={`${id}-notes`}
						className="pk-chat-input pk-chat-notes pk-focus-ring"
						rows={2}
						value={draft.notes}
						aria-describedby={`${id}-notes-hint`}
						data-testid="chat-question-notes"
						onChange={(event) => onChange({ notes: event.target.value })}
					/>
					<p id={`${id}-notes-hint`} className="pk-chat-hint">
						{last
							? "Enter adds a line. Ctrl+Enter submits."
							: "Enter adds a line. Ctrl+Enter goes to the next question."}
					</p>
				</div>
			) : (
				<Button
					variant="quiet"
					size="sm"
					iconStart="plus"
					className="pk-chat-add-note"
					data-testid="chat-question-add-note"
					onClick={() => setNoting(true)}
				>
					Add a note
				</Button>
			)}
		</fieldset>
	);
}

/**
 * A native radio or checkbox with its label and description, as one
 * full-width row. Native boxes, not the Checkbox primitive, so the two
 * kinds of question look and behave alike.
 */
function OptionRow({
	type,
	name,
	label,
	description,
	describedBy,
	checked,
	onChange,
}: {
	type: "radio" | "checkbox";
	name: string;
	label: string;
	description?: string;
	describedBy?: string | undefined;
	checked: boolean;
	onChange: (on: boolean, byPointer: boolean) => void;
}) {
	const id = useId();
	const pointer = useRef(false);
	const described = [description ? `${id}-description` : null, describedBy ?? null]
		.filter((part) => part !== null)
		.join(" ");
	return (
		<label
			className="pk-chat-option-row"
			onPointerDown={() => {
				pointer.current = true;
			}}
		>
			<input
				type={type}
				name={type === "radio" ? name : undefined}
				className="pk-focus-ring"
				checked={checked}
				// The description describes the option; it is not part of its name.
				aria-labelledby={`${id}-label`}
				aria-describedby={described || undefined}
				onKeyDown={() => {
					pointer.current = false;
				}}
				onChange={(event) => {
					onChange(event.target.checked, pointer.current);
					pointer.current = false;
				}}
			/>
			<span className="pk-chat-option-copy">
				<span id={`${id}-label`} className="pk-chat-option-label">
					{label}
				</span>
				{description ? (
					<span id={`${id}-description`} className="pk-chat-muted">
						{description}
					</span>
				) : null}
			</span>
		</label>
	);
}

/**
 * Claude's AskUserQuestion as a form (SPEC.md §10.8): per question a header
 * chip, the options with their descriptions, an "Other" answer and an
 * optional note. Options with a preview show the focused one beside the
 * list, or under it in a narrow pane. Enter on an option sends; in a note
 * Enter adds a line and Ctrl+Enter sends, as the hint under it says.
 */
import type { ChatOpenCard, ChatQuestion } from "@portikus/contracts";
import { Button, Checkbox, Icon } from "@portikus/ui";
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import {
	buildQuestionAnswer,
	emptyDraft,
	type QuestionDraft,
} from "./questionAnswer.js";
import { waitingText } from "./waiting.js";

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

export function QuestionCard({
	card,
	onAnswer,
	takeFocus,
	waiting,
}: QuestionCardProps) {
	const titleId = useId();
	const form = useRef<HTMLFormElement | null>(null);
	const [drafts, setDrafts] = useState<QuestionDraft[]>(() =>
		card.questions.map(() => emptyDraft),
	);
	const [error, setError] = useState("");
	const [sent, setSent] = useState(false);
	const count = card.questions.length;

	// biome-ignore lint/correctness/useExhaustiveDependencies: only as the card first appears
	useEffect(() => {
		if (takeFocus()) form.current?.querySelector<HTMLElement>("input")?.focus();
	}, []);

	function update(at: number, change: Partial<QuestionDraft>) {
		setDrafts((all) =>
			all.map((draft, index) => (index === at ? { ...draft, ...change } : draft)),
		);
		setError("");
	}

	function submit(event?: FormEvent) {
		event?.preventDefault();
		if (sent) return;
		const answer = buildQuestionAnswer(card.questions, drafts);
		if (!answer.ok) {
			setError(
				count === 1
					? "Pick an answer, or write your own under Other."
					: "Answer every question: pick an option, or write your own under Other.",
			);
			const first = answer.missing[0] ?? 0;
			form.current
				?.querySelectorAll<HTMLFieldSetElement>("fieldset")
				[first]?.querySelector<HTMLElement>("input")
				?.focus();
			return;
		}
		if (!onAnswer(answer.answers, answer.notes)) {
			setError(NOT_SENT);
			return;
		}
		setSent(true);
	}

	function onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing)
			return;
		const target = event.target as HTMLElement;
		// Ctrl+Enter sends from anywhere, a note included.
		if (event.ctrlKey || event.metaKey) {
			event.preventDefault();
			submit();
			return;
		}
		// Buttons and text fields already submit on Enter; boxes do not. A note adds a line.
		if (
			target instanceof HTMLInputElement &&
			(target.type === "radio" || target.type === "checkbox")
		) {
			event.preventDefault();
			submit();
		}
	}

	return (
		<section
			className="pk-chat-card"
			aria-labelledby={titleId}
			data-testid="chat-question-card"
		>
			<h2 id={titleId} className="pk-text-heading">
				{count === 1 ? "Claude has a question" : `Claude has ${count} questions`}
			</h2>
			<form
				ref={form}
				className="pk-chat-card-form"
				noValidate={true}
				onSubmit={submit}
				onKeyDown={onKeyDown}
			>
				{card.questions.map((question, at) => (
					<QuestionFields
						// Questions never change while the card is open.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above
						key={at}
						question={question}
						draft={drafts[at] ?? emptyDraft}
						onChange={(change) => update(at, change)}
					/>
				))}
				<p className="pk-chat-card-error" role="alert">
					{error}
				</p>
				<div className="pk-chat-card-actions">
					<Button
						type="submit"
						variant="primary"
						loading={sent}
						data-testid="chat-question-send"
					>
						{count === 1 ? "Send answer" : "Send answers"}
					</Button>
					{waiting > 0 ? (
						<p className="pk-chat-card-waiting" data-testid="chat-cards-waiting">
							{waitingText(waiting)}
						</p>
					) : null}
				</div>
			</form>
		</section>
	);
}

function QuestionFields({
	question,
	draft,
	onChange,
}: {
	question: ChatQuestion;
	draft: QuestionDraft;
	onChange: (change: Partial<QuestionDraft>) => void;
}) {
	const id = useId();
	const name = `${id}-pick`;
	const otherField = useRef<HTMLInputElement | null>(null);
	const notesField = useRef<HTMLTextAreaElement | null>(null);
	const [focused, setFocused] = useState<string | null>(null);
	const [noting, setNoting] = useState(false);

	// "Add a note" goes away with its own click, so the new field takes the keyboard.
	useEffect(() => {
		if (noting) notesField.current?.focus();
	}, [noting]);
	const single = !question.multiSelect;
	const withPreview = question.options.filter((option) => option.preview !== undefined);
	const shown =
		withPreview.find((option) => option.label === focused) ??
		withPreview.find((option) => draft.picked.includes(option.label)) ??
		withPreview[0];

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
			aria-describedby={`${id}-how`}
		>
			<legend className="pk-chat-question-legend">
				{question.header ? (
					<span className="pk-chat-chip pk-text-caption">
						{question.header}
						<span className="sr-only">: </span>
					</span>
				) : null}
				<span className="pk-chat-question-text">{question.question}</span>
			</legend>
			<p id={`${id}-how`} className="sr-only">
				{single ? "Pick one." : "Pick any that apply."}
			</p>
			<div className={`pk-chat-question-body${shown ? " has-preview" : ""}`}>
				<ul className="pk-chat-options">
					{question.options.map((option, at) => {
						const previewId =
							option.preview !== undefined ? `${id}-preview-${at}` : undefined;
						return (
							<li
								key={option.label}
								onFocus={() => setFocused(option.label)}
								onMouseEnter={() =>
									option.preview !== undefined && setFocused(option.label)
								}
							>
								{single ? (
									<Radio
										name={name}
										label={option.label}
										description={option.description}
										describedBy={previewId}
										checked={!draft.otherPicked && draft.picked[0] === option.label}
										onChange={() => toggle(option.label, true)}
									/>
								) : (
									<Checkbox
										label={option.label}
										description={
											option.preview !== undefined ? (
												<>
													{option.description}
													<span className="sr-only">{` Preview: ${option.preview}`}</span>
												</>
											) : (
												option.description || undefined
											)
										}
										checked={draft.picked.includes(option.label)}
										onChange={(event) => toggle(option.label, event.target.checked)}
									/>
								)}
								{/* The preview read with its option, which the panel beside the list shows to the eye. */}
								{single && previewId ? (
									<span id={previewId} hidden={true}>
										{`Preview: ${option.preview}`}
									</span>
								) : null}
							</li>
						);
					})}
					<li className="pk-chat-other">
						{single ? (
							<Radio
								name={name}
								label="Other"
								checked={draft.otherPicked}
								onChange={() => {
									onChange({ picked: [], otherPicked: true });
									otherField.current?.focus();
								}}
							/>
						) : null}
						<label
							className={single ? "sr-only" : "pk-chat-field-label"}
							htmlFor={`${id}-other`}
						>
							{single ? "Your own answer" : "Other"}
						</label>
						<input
							ref={otherField}
							id={`${id}-other`}
							className="pk-chat-input pk-focus-ring"
							type="text"
							value={draft.other}
							placeholder="Write your own answer"
							data-testid="chat-question-other"
							onChange={(event) =>
								onChange(
									single && event.target.value !== ""
										? { other: event.target.value, picked: [], otherPicked: true }
										: { other: event.target.value },
								)
							}
						/>
					</li>
				</ul>
				{shown ? (
					<figure className="pk-chat-preview">
						<figcaption className="pk-chat-preview-caption">
							Preview: {shown.label}
						</figcaption>
						<pre
							className="pk-chat-code"
							// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box must be reachable by keyboard
							tabIndex={0}
							data-testid="chat-question-preview"
						>
							{shown.preview}
						</pre>
					</figure>
				) : null}
			</div>
			{noting || draft.notes !== "" ? (
				<div className="pk-chat-note">
					<label className="pk-chat-field-label" htmlFor={`${id}-notes`}>
						Notes <span className="pk-chat-muted">(optional)</span>
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
						Enter adds a line. Ctrl+Enter or the Send button sends.
					</p>
				</div>
			) : (
				<Button
					variant="quiet"
					size="sm"
					className="pk-chat-add-note"
					data-testid="chat-question-add-note"
					onClick={() => setNoting(true)}
				>
					<Icon name="plus" size="sm" />
					Add a note
				</Button>
			)}
		</fieldset>
	);
}

/** A native radio laid out like the Checkbox primitive, label beside description. */
function Radio({
	name,
	label,
	description,
	describedBy,
	checked,
	onChange,
}: {
	name: string;
	label: string;
	description?: string;
	describedBy?: string;
	checked: boolean;
	onChange: () => void;
}) {
	const id = useId();
	const described = [description ? `${id}-description` : null, describedBy ?? null]
		.filter((part) => part !== null)
		.join(" ");
	return (
		<label className="pk-chat-radio">
			<input
				type="radio"
				name={name}
				className="pk-focus-ring"
				checked={checked}
				// The description describes the option; it is not part of its name.
				aria-labelledby={`${id}-label`}
				aria-describedby={described || undefined}
				onChange={onChange}
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

/**
 * Claude's AskUserQuestion as a form (Epic 58 plan, rulings 8 and 9): per
 * question a header chip, the options with their descriptions, an "Other"
 * answer and a note. Options with a preview show the focused one beside the
 * list, or under it in a narrow pane. Enter sends from any field; Shift+Enter
 * starts a new line in a note.
 */
import type { ChatOpenCard, ChatQuestion } from "@portikus/contracts";
import { Button, Checkbox } from "@portikus/ui";
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
}

const NOT_SENT =
	"Your answer was not sent because the chat is not connected. Wait for it to reconnect, then send again.";

export function QuestionCard({ card, onAnswer, takeFocus }: QuestionCardProps) {
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

	function submit(event: FormEvent) {
		event.preventDefault();
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
		// Buttons and text fields already submit on Enter; boxes and notes do not.
		if (
			target instanceof HTMLInputElement &&
			(target.type === "radio" || target.type === "checkbox")
		) {
			event.preventDefault();
			form.current?.requestSubmit();
		} else if (target instanceof HTMLTextAreaElement) {
			event.preventDefault();
			form.current?.requestSubmit();
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
	const [focused, setFocused] = useState<string | null>(null);
	const single = !question.multiSelect;
	const otherChosen = single && draft.picked.length === 0 && draft.other !== "";
	const withPreview = question.options.filter((option) => option.preview !== undefined);
	const shown =
		withPreview.find((option) => option.label === focused) ??
		withPreview.find((option) => draft.picked.includes(option.label)) ??
		withPreview[0];

	function toggle(label: string, on: boolean) {
		if (single) onChange({ picked: [label] });
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
					{question.options.map((option) => (
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
									checked={draft.picked[0] === option.label}
									onChange={() => toggle(option.label, true)}
								/>
							) : (
								<Checkbox
									label={option.label}
									description={option.description || undefined}
									checked={draft.picked.includes(option.label)}
									onChange={(event) => toggle(option.label, event.target.checked)}
								/>
							)}
						</li>
					))}
					<li className="pk-chat-other">
						{single ? (
							<Radio
								name={name}
								label="Other"
								checked={otherChosen}
								onChange={() => onChange({ picked: [] })}
							/>
						) : null}
						<label
							className={single ? "sr-only" : "pk-chat-field-label"}
							htmlFor={`${id}-other`}
						>
							{single ? "Your own answer" : "Other"}
						</label>
						<input
							id={`${id}-other`}
							className="pk-chat-input pk-focus-ring"
							type="text"
							value={draft.other}
							placeholder="Write your own answer"
							data-testid="chat-question-other"
							onChange={(event) =>
								onChange(
									single && event.target.value !== ""
										? { other: event.target.value, picked: [] }
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
			<label className="pk-chat-field-label" htmlFor={`${id}-notes`}>
				Notes <span className="pk-chat-muted">(optional)</span>
			</label>
			<textarea
				id={`${id}-notes`}
				className="pk-chat-input pk-chat-notes pk-focus-ring"
				rows={2}
				value={draft.notes}
				data-testid="chat-question-notes"
				onChange={(event) => onChange({ notes: event.target.value })}
			/>
		</fieldset>
	);
}

/** A native radio laid out like the Checkbox primitive, label over description. */
function Radio({
	name,
	label,
	description,
	checked,
	onChange,
}: {
	name: string;
	label: string;
	description?: string;
	checked: boolean;
	onChange: () => void;
}) {
	const id = useId();
	return (
		<label className="pk-chat-radio">
			<input
				type="radio"
				name={name}
				className="pk-focus-ring"
				checked={checked}
				// The description describes the option; it is not part of its name.
				aria-labelledby={`${id}-label`}
				aria-describedby={description ? `${id}-description` : undefined}
				onChange={onChange}
			/>
			<span className="pk-checkbox-copy">
				<span id={`${id}-label`}>{label}</span>
				{description ? (
					<span id={`${id}-description`} className="pk-chat-muted">
						{description}
					</span>
				) : null}
			</span>
		</label>
	);
}

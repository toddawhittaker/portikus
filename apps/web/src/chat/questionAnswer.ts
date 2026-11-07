import type { ChatQuestion } from "@portikus/contracts";

/** What the student has chosen and written for one question. */
export interface QuestionDraft {
	/** Labels of the picked options; at most one for a single-select question. */
	picked: string[];
	other: string;
	notes: string;
}

export const emptyDraft: QuestionDraft = { picked: [], other: "", notes: "" };

export type QuestionAnswer =
	| { ok: true; answers: Record<string, string>; notes?: Record<string, string> }
	/** Indexes of the questions with neither a pick nor an "Other" answer. */
	| { ok: false; missing: number[] };

/**
 * The `question.answer` payload, keyed by question text as Claude expects.
 * Picks are joined with commas; "Other" text is the answer when nothing is
 * picked, and a note otherwise, ahead of any notes the student wrote.
 */
export function buildQuestionAnswer(
	questions: readonly ChatQuestion[],
	drafts: readonly QuestionDraft[],
): QuestionAnswer {
	const answers: Record<string, string> = {};
	const notes: Record<string, string> = {};
	const missing: number[] = [];
	questions.forEach((question, at) => {
		const draft = drafts[at] ?? emptyDraft;
		const other = draft.other.trim();
		const answer = draft.picked.length > 0 ? draft.picked.join(", ") : other;
		if (answer === "") {
			missing.push(at);
			return;
		}
		answers[question.question] = answer;
		const note = [draft.picked.length > 0 ? other : "", draft.notes.trim()]
			.filter((part) => part !== "")
			.join("\n");
		if (note !== "") notes[question.question] = note;
	});
	if (missing.length > 0) return { ok: false, missing };
	return Object.keys(notes).length > 0
		? { ok: true, answers, notes }
		: { ok: true, answers };
}

import type { ChatCardQuestion } from "@portikus/contracts";

/** What the student has chosen and written for one question. */
export interface QuestionDraft {
	/** Labels of the picked options, in option order; at most one for a single-select question. */
	picked: string[];
	/** "Other" is chosen: alone for a single-select question, beside the picks for a multi-select one. */
	otherPicked: boolean;
	other: string;
	notes: string;
	/** The student chose not to answer. */
	skipped: boolean;
}

export const emptyDraft: QuestionDraft = {
	picked: [],
	otherPicked: false,
	other: "",
	notes: "",
	skipped: false,
};

/**
 * The answer a draft gives, as Claude reads it: the picked labels and any
 * "Other" text, joined with commas. Empty when the draft gives none.
 */
export function draftAnswer(question: ChatCardQuestion, draft: QuestionDraft): string {
	// With nothing to pick, the student's own words are the whole answer.
	if (question.options.length === 0) return draft.other.trim();
	const other = draft.otherPicked ? draft.other.trim() : "";
	if (!question.multiSelect) return draft.otherPicked ? other : (draft.picked[0] ?? "");
	return [...draft.picked, other].filter((part) => part !== "").join(", ");
}

/** The student may move on: the question is answered or skipped. */
export function isSettled(question: ChatCardQuestion, draft: QuestionDraft): boolean {
	return draft.skipped || draftAnswer(question, draft) !== "";
}

export type QuestionAnswer =
	| { ok: true; answers: Record<string, string>; notes?: Record<string, string> }
	/** Indexes of the questions neither answered nor skipped. */
	| { ok: false; missing: number[] };

/**
 * The `question.answer` payload, keyed by question text as Claude expects.
 * A skipped question is left out, which the host reports to Claude as
 * unanswered; its note goes with it.
 */
export function buildQuestionAnswer(
	questions: readonly ChatCardQuestion[],
	drafts: readonly QuestionDraft[],
): QuestionAnswer {
	const answers: Record<string, string> = {};
	const notes: Record<string, string> = {};
	const missing: number[] = [];
	questions.forEach((question, at) => {
		const draft = drafts[at] ?? emptyDraft;
		if (draft.skipped) return;
		const answer = draftAnswer(question, draft);
		if (answer === "") {
			missing.push(at);
			return;
		}
		answers[question.question] = answer;
		const note = draft.notes.trim();
		if (note !== "") notes[question.question] = note;
	});
	if (missing.length > 0) return { ok: false, missing };
	return Object.keys(notes).length > 0
		? { ok: true, answers, notes }
		: { ok: true, answers };
}

/** One asked question as the conversation shows it afterwards. */
export interface AskedQuestion {
	question: string;
	/** Null when the student skipped it, or the turn ended first. */
	answer: string | null;
}

/** The questions an AskUserQuestion tool call carried, or null when its input is not that shape. */
export function askedQuestions(input: unknown): string[] | null {
	if (typeof input !== "object" || input === null) return null;
	const questions = (input as { questions?: unknown }).questions;
	if (!Array.isArray(questions) || questions.length === 0) return null;
	const texts = questions.map((one) =>
		typeof one === "object" && one !== null && typeof one.question === "string"
			? one.question
			: null,
	);
	return texts.every((text) => text !== null) ? (texts as string[]) : null;
}

/** The text of each question an AskUserQuestion call marks `secret`; its answer is never shown. */
export function secretQuestions(input: unknown): Set<string> {
	const secrets = new Set<string>();
	if (typeof input !== "object" || input === null) return secrets;
	const questions = (input as { questions?: unknown }).questions;
	if (!Array.isArray(questions)) return secrets;
	for (const one of questions) {
		if (typeof one === "object" && one !== null && one.secret === true) {
			if (typeof one.question === "string") secrets.add(one.question);
		}
	}
	return secrets;
}

/**
 * Each question with the answer Claude was given, read from the tool's
 * result. Claude Code writes the answers as `"question"="answer"` pairs
 * joined by `", "`; a question with no pair was not answered.
 */
export function readAnswers(
	questions: readonly string[],
	result: string,
): AskedQuestion[] {
	const found = questions
		.map((question, at) => {
			const marker = `"${question}"="`;
			const start = result.indexOf(marker);
			return { at, start, from: start + marker.length };
		})
		.filter((one) => one.start >= 0)
		.sort((a, b) => a.start - b.start);
	const answers = new Map<number, string>();
	found.forEach((one, index) => {
		const next = found[index + 1];
		const segment = result.slice(one.from, next ? next.start : result.length);
		const close = segment.lastIndexOf('"');
		if (close >= 0) answers.set(one.at, segment.slice(0, close));
	});
	return questions.map((question, at) => ({
		question,
		answer: answers.get(at) ?? null,
	}));
}

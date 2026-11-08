import type { ChatQuestion } from "@portikus/contracts";
import { expect, test } from "vitest";
import {
	askedQuestions,
	buildQuestionAnswer,
	draftAnswer,
	emptyDraft,
	isSettled,
	readAnswers,
} from "./questionAnswer";

function question(text: string, multiSelect: boolean): ChatQuestion {
	return {
		question: text,
		header: "H",
		multiSelect,
		options: [
			{ label: "Red", description: "" },
			{ label: "Green", description: "" },
			{ label: "Blue", description: "" },
		],
	};
}

const single = question("Which colour?", false);
const multi = question("Which colours?", true);

test("a single pick is the answer", () => {
	expect(buildQuestionAnswer([single], [{ ...emptyDraft, picked: ["Green"] }])).toEqual(
		{
			ok: true,
			answers: { "Which colour?": "Green" },
		},
	);
});

test("multi-select picks are joined with commas in option order", () => {
	expect(
		buildQuestionAnswer([multi], [{ ...emptyDraft, picked: ["Red", "Blue"] }]),
	).toEqual({ ok: true, answers: { "Which colours?": "Red, Blue" } });
});

test("a single-select Other answer is its text, and only once Other is chosen", () => {
	const other = { ...emptyDraft, otherPicked: true, other: "  Teal  " };
	expect(draftAnswer(single, other)).toBe("Teal");
	expect(draftAnswer(single, { ...other, otherPicked: false })).toBe("");
	expect(draftAnswer(single, { ...other, other: " " })).toBe("");
});

test("multi-select Other text is sent with the picks", () => {
	expect(
		draftAnswer(multi, {
			...emptyDraft,
			picked: ["Red", "Blue"],
			otherPicked: true,
			other: "and teal",
		}),
	).toBe("Red, Blue, and teal");
	expect(draftAnswer(multi, { ...emptyDraft, otherPicked: true, other: "Teal" })).toBe(
		"Teal",
	);
	// Other ticked but empty adds nothing to the picks.
	expect(
		draftAnswer(multi, { ...emptyDraft, picked: ["Red"], otherPicked: true }),
	).toBe("Red");
});

test("a note goes with its question's answer", () => {
	expect(
		buildQuestionAnswer(
			[single, multi],
			[
				{ ...emptyDraft, otherPicked: true, other: "Teal", notes: " darker " },
				{ ...emptyDraft, picked: ["Blue"], notes: "  " },
			],
		),
	).toEqual({
		ok: true,
		answers: { "Which colour?": "Teal", "Which colours?": "Blue" },
		notes: { "Which colour?": "darker" },
	});
});

test("a skipped question is left out, with its note", () => {
	expect(
		buildQuestionAnswer(
			[single, multi],
			[
				{ ...emptyDraft, picked: ["Red"], skipped: true, notes: "ignored" },
				{ ...emptyDraft, picked: ["Blue"] },
			],
		),
	).toEqual({ ok: true, answers: { "Which colours?": "Blue" } });
	expect(buildQuestionAnswer([single], [{ ...emptyDraft, skipped: true }])).toEqual({
		ok: true,
		answers: {},
	});
});

test("a question is settled once answered or skipped", () => {
	expect(isSettled(single, emptyDraft)).toBe(false);
	expect(isSettled(single, { ...emptyDraft, otherPicked: true })).toBe(false);
	expect(isSettled(single, { ...emptyDraft, picked: ["Red"] })).toBe(true);
	expect(isSettled(multi, { ...emptyDraft, skipped: true })).toBe(true);
});

test("questions neither answered nor skipped are named, and nothing is sent", () => {
	expect(
		buildQuestionAnswer(
			[single, multi, single],
			[
				{ ...emptyDraft, picked: ["Red"] },
				{ ...emptyDraft, notes: "only a note" },
			],
		),
	).toEqual({ ok: false, missing: [1, 2] });
});

test("the questions are read from an AskUserQuestion input", () => {
	expect(
		askedQuestions({ questions: [{ question: "A?" }, { question: "B?" }] }),
	).toEqual(["A?", "B?"]);
	expect(askedQuestions({ questions: [] })).toBeNull();
	expect(askedQuestions({ questions: [{ header: "x" }] })).toBeNull();
	expect(askedQuestions("A?")).toBeNull();
	expect(askedQuestions(null)).toBeNull();
});

test("answers are read from Claude Code's result, and a missing one is skipped", () => {
	const result =
		'Your questions have been answered: "Which colour?"="Teal, "dark"", "Which size?"="Large". You can now continue with these answers in mind.';
	expect(readAnswers(["Which size?", "Which colour?", "Which shape?"], result)).toEqual(
		[
			{ question: "Which size?", answer: "Large" },
			{ question: "Which colour?", answer: 'Teal, "dark"' },
			{ question: "Which shape?", answer: null },
		],
	);
	expect(
		readAnswers(["Which size?"], "The user did not answer the questions."),
	).toEqual([{ question: "Which size?", answer: null }]);
});

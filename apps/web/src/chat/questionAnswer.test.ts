import type { ChatQuestion } from "@portikus/contracts";
import { expect, test } from "vitest";
import { buildQuestionAnswer, emptyDraft } from "./questionAnswer";

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

test("Other is the answer when nothing is picked", () => {
	expect(buildQuestionAnswer([single], [{ ...emptyDraft, other: "  Teal  " }])).toEqual(
		{
			ok: true,
			answers: { "Which colour?": "Teal" },
		},
	);
});

test("Other becomes a note when something is picked, ahead of the student's note", () => {
	expect(
		buildQuestionAnswer(
			[multi, single],
			[
				{ ...emptyDraft, picked: ["Red"], other: "and teal", notes: "for the header" },
				{ ...emptyDraft, picked: ["Blue"], notes: "  " },
			],
		),
	).toEqual({
		ok: true,
		answers: { "Which colours?": "Red", "Which colour?": "Blue" },
		notes: { "Which colours?": "and teal\nfor the header" },
	});
});

test("a note goes with an Other answer too", () => {
	expect(
		buildQuestionAnswer(
			[single],
			[{ ...emptyDraft, otherPicked: true, other: "Teal", notes: "darker" }],
		),
	).toEqual({
		ok: true,
		answers: { "Which colour?": "Teal" },
		notes: { "Which colour?": "darker" },
	});
});

test("unanswered questions are named, and nothing is sent", () => {
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

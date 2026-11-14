import type { ChatCardQuestion, ChatOpenCard } from "@portikus/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatAgentContext } from "./chatAgent";
import { QuestionCard } from "./QuestionCard";

afterEach(cleanup);

const QUESTION: Extract<ChatOpenCard, { type: "question" }> = {
	type: "question",
	id: "q1",
	questions: [
		{
			question: "Which layout?",
			header: "Layout",
			multiSelect: false,
			options: [
				{ label: "Grid", description: "Rows and columns", preview: "+--+--+" },
				{ label: "Stack", description: "One column", preview: "+-----+" },
			],
		},
		{
			question: "Which checks?",
			header: "Checks",
			multiSelect: true,
			options: [
				{ label: "Lint", description: "" },
				{ label: "Types", description: "" },
				{ label: "Tests", description: "" },
			],
		},
	],
};

function draw(onAnswer = vi.fn(() => true), takeFocus = () => true, waiting = 0) {
	render(
		<QuestionCard
			card={QUESTION}
			onAnswer={onAnswer}
			takeFocus={takeFocus}
			waiting={waiting}
		/>,
	);
	return onAnswer;
}

const next = () => screen.getByRole("button", { name: "Next" });
const submit = () => screen.getByRole("button", { name: "Submit" });
const position = () => screen.getByTestId("chat-question-position").textContent;

test("one question shows at a time, with its position, and takes focus on its first option", () => {
	draw();
	expect(screen.getByRole("heading", { name: "Which layout?" })).toBeTruthy();
	expect(screen.getByRole("group", { name: "Which layout?" })).toBeTruthy();
	expect(screen.queryByText("Which checks?")).toBeNull();
	expect(position()).toBe("1 of 2");
	expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Grid" }));
	expect(screen.queryByText("Pick any that apply")).toBeNull();
});

test("it leaves focus alone when told not to take it", () => {
	draw(
		vi.fn(() => true),
		() => false,
	);
	expect(document.activeElement).toBe(document.body);
});

test("Next waits for an answer and says why; then the next question takes focus", () => {
	const onAnswer = draw();
	expect(next().getAttribute("aria-disabled")).toBe("true");
	fireEvent.click(next());
	expect(screen.getByRole("alert").textContent).toContain("skip this question");
	expect(position()).toBe("1 of 2");
	fireEvent.click(screen.getByRole("radio", { name: "Stack" }));
	expect(screen.getByRole("alert").textContent).toBe("");
	expect(next().getAttribute("aria-disabled")).toBeNull();
	fireEvent.click(next());
	expect(position()).toBe("2 of 2");
	expect(screen.getByText("Pick any that apply")).toBeTruthy();
	expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: "Lint" }));
	expect(screen.getByText("Question 2 of 2: Which checks?")).toBeTruthy();
	expect(onAnswer).not.toHaveBeenCalled();
});

test("the pager goes back with the answers kept, and forward only as far as reached", () => {
	draw();
	const back = screen.getByRole("button", { name: "Previous question" });
	const forward = screen.getByRole("button", { name: "Next question" });
	expect(back.getAttribute("aria-disabled")).toBe("true");
	expect(forward.getAttribute("aria-disabled")).toBe("true");
	fireEvent.click(screen.getByRole("radio", { name: "Stack" }));
	fireEvent.click(next());
	fireEvent.click(screen.getByRole("button", { name: "Previous question" }));
	expect(position()).toBe("1 of 2");
	expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Stack" }));
	expect(
		(screen.getByRole("radio", { name: "Stack" }) as HTMLInputElement).checked,
	).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "Next question" }));
	expect(position()).toBe("2 of 2");
});

/** The text a control's aria-describedby points at, as a screen reader reads it. */
function why(control: HTMLElement): string {
	const ids = control.getAttribute("aria-describedby")?.split(" ") ?? [];
	return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
}

test("an unavailable pager arrow says why", () => {
	draw();
	const back = () => screen.getByRole("button", { name: "Previous question" });
	const forward = () => screen.getByRole("button", { name: "Next question" });
	expect(why(back())).toBe("This is the first question.");
	expect(why(forward())).toContain("skip this question");
	fireEvent.click(screen.getByRole("radio", { name: "Stack" }));
	expect(forward().getAttribute("aria-disabled")).toBe("true");
	expect(why(forward())).toBe("Use Next to go on.");
	fireEvent.click(next());
	expect(back().getAttribute("aria-disabled")).toBeNull();
	expect(back().getAttribute("aria-describedby")).toBeNull();
	fireEvent.click(screen.getByRole("checkbox", { name: "Lint" }));
	expect(why(forward())).toBe("This is the last question.");
});

test("picks, Other beside them and a note send the right answer", () => {
	const onAnswer = draw();
	fireEvent.click(screen.getByRole("radio", { name: "Grid" }));
	fireEvent.click(screen.getByRole("button", { name: "Add a note" }));
	const note = screen.getByRole("textbox", { name: "Note (optional)" });
	expect(document.activeElement).toBe(note);
	fireEvent.change(note, { target: { value: "Keep it simple" } });
	fireEvent.click(next());
	fireEvent.click(screen.getByRole("checkbox", { name: "Tests" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "Lint" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "Other" }));
	fireEvent.change(screen.getByRole("textbox", { name: "Your own answer" }), {
		target: { value: "a build" },
	});
	// The note belonged to the first question; this one starts closed.
	expect(screen.getByRole("button", { name: "Add a note" })).toBeTruthy();
	fireEvent.click(submit());
	expect(onAnswer).toHaveBeenCalledWith(
		{ "Which layout?": "Grid", "Which checks?": "Lint, Tests, a build" },
		{ "Which layout?": "Keep it simple" },
	);
	expect(submit().getAttribute("aria-busy")).toBe("true");
});

test("Skip leaves a question out; Skip all sends nothing answered", () => {
	const onAnswer = draw();
	fireEvent.click(screen.getByRole("button", { name: "Skip" }));
	expect(position()).toBe("2 of 2");
	fireEvent.click(screen.getByRole("checkbox", { name: "Types" }));
	fireEvent.click(submit());
	expect(onAnswer).toHaveBeenLastCalledWith({ "Which checks?": "Types" }, undefined);
	cleanup();
	const all = draw();
	fireEvent.click(screen.getByRole("radio", { name: "Grid" }));
	fireEvent.click(screen.getByRole("button", { name: "Skip all" }));
	expect(all).toHaveBeenCalledWith({}, undefined);
});

test("choosing Other by pointer opens its field for typing; an arrow key does not move into it", () => {
	draw();
	expect(screen.queryByRole("textbox", { name: "Your own answer" })).toBeNull();
	const other = screen.getByRole("radio", { name: "Other" });
	fireEvent.pointerDown(other);
	fireEvent.click(other);
	expect((other as HTMLInputElement).checked).toBe(true);
	const field = screen.getByRole("textbox", { name: "Your own answer" });
	expect(next().getAttribute("aria-disabled")).toBe("true");
	fireEvent.change(field, { target: { value: "Teal" } });
	expect(next().getAttribute("aria-disabled")).toBeNull();
});

test("Enter on an option or Ctrl+Enter in a note goes on; Enter in a note adds a line", () => {
	const onAnswer = draw();
	const grid = screen.getByRole("radio", { name: "Grid" });
	fireEvent.click(grid);
	fireEvent.keyDown(grid, { key: "Enter" });
	expect(position()).toBe("2 of 2");
	fireEvent.click(screen.getByRole("checkbox", { name: "Lint" }));
	fireEvent.click(screen.getByRole("button", { name: "Add a note" }));
	const note = screen.getByRole("textbox", { name: "Note (optional)" });
	expect(
		document.getElementById(note.getAttribute("aria-describedby") ?? "")?.textContent,
	).toBe("Enter adds a line. Ctrl+Enter submits.");
	fireEvent.keyDown(note, { key: "Enter" });
	expect(onAnswer).not.toHaveBeenCalled();
	fireEvent.keyDown(note, { key: "Enter", ctrlKey: true });
	expect(onAnswer).toHaveBeenCalledTimes(1);
});

test("arrow keys move between checkboxes; Space is the box's own", () => {
	draw();
	fireEvent.click(screen.getByRole("radio", { name: "Grid" }));
	fireEvent.click(next());
	const lint = screen.getByRole("checkbox", { name: "Lint" });
	fireEvent.keyDown(lint, { key: "ArrowDown" });
	expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: "Types" }));
	fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
	expect(document.activeElement).toBe(lint);
});

test("each option is described by its own description and preview", () => {
	draw();
	const described = (
		screen.getByRole("radio", { name: "Stack" }).getAttribute("aria-describedby") ?? ""
	)
		.split(" ")
		.map((id) => document.getElementById(id)?.textContent);
	expect(described).toEqual(["One column", "+-----+"]);
	expect(screen.getAllByTestId("chat-question-preview")).toHaveLength(2);
});

test("a card says how many more wait behind it", () => {
	draw(
		vi.fn(() => true),
		() => false,
		2,
	);
	expect(screen.getByTestId("chat-cards-waiting").textContent).toBe(
		"2 more requests are waiting.",
	);
});

test("an answer that could not be sent says so and can be sent again", () => {
	const onAnswer = vi.fn(() => false);
	draw(onAnswer);
	fireEvent.click(screen.getByRole("radio", { name: "Grid" }));
	fireEvent.click(next());
	fireEvent.click(screen.getByRole("checkbox", { name: "Lint" }));
	fireEvent.click(submit());
	expect(screen.getByRole("alert").textContent).toContain("not connected");
	onAnswer.mockReturnValue(true);
	fireEvent.click(submit());
	expect(onAnswer).toHaveBeenCalledTimes(2);
	expect(submit().getAttribute("aria-busy")).toBe("true");
});

test("an extra action sits first in the footer, before Skip all", () => {
	render(
		<QuestionCard
			card={QUESTION}
			onAnswer={vi.fn(() => true)}
			takeFocus={() => false}
			waiting={0}
			extraAction={<button type="button">Elsewhere</button>}
		/>,
	);
	const buttons = Array.from(
		screen.getByTestId("chat-question-card").querySelectorAll("footer button"),
	).map((button) => button.textContent);
	expect(buttons[0]).toBe("Elsewhere");
	expect(buttons[1]).toBe("Skip all");
});

function drawFor(
	questions: Extract<ChatOpenCard, { type: "question" }>["questions"],
	agent: "claude" | "codex" = "codex",
	onAnswer = vi.fn(
		(_answers: Record<string, string>, _notes?: Record<string, string>) => true,
	),
) {
	render(
		<ChatAgentContext.Provider value={agent}>
			<QuestionCard
				card={{ type: "question", id: "q9", questions }}
				onAnswer={onAnswer}
				takeFocus={() => true}
				waiting={0}
			/>
		</ChatAgentContext.Provider>,
	);
	return onAnswer;
}

const FREE_TEXT = {
	question: "Which branch should I use?",
	header: "Branch",
	multiSelect: false,
	options: [],
};

test("a question with no options is one text field, with no list and no note", () => {
	const onAnswer = drawFor([FREE_TEXT]);
	expect(screen.getByRole("region", { name: "Codex's question" })).toBeTruthy();
	const field = screen.getByRole("textbox", { name: "Which branch should I use?" });
	expect((field as HTMLInputElement).type).toBe("text");
	expect(document.activeElement).toBe(field);
	expect(screen.queryAllByRole("radio")).toHaveLength(0);
	expect(screen.queryByText("Other")).toBeNull();
	expect(screen.queryByTestId("chat-question-add-note")).toBeNull();
	// Nothing typed: Submit says what is missing and sends nothing.
	fireEvent.click(submit());
	expect(onAnswer).not.toHaveBeenCalled();
	expect(screen.getByRole("alert").textContent).toContain(
		"Pick an answer or write your own",
	);
	// Enter in the field submits, as it does on an option.
	fireEvent.change(field, { target: { value: "  main  " } });
	fireEvent.keyDown(field, { key: "Enter" });
	expect(onAnswer).toHaveBeenCalledExactlyOnceWith(
		{ "Which branch should I use?": "main" },
		undefined,
	);
});

test("a secret question is a password field that is not echoed anywhere", () => {
	const onAnswer = drawFor([{ ...FREE_TEXT, question: "API key?", secret: true }]);
	const field = screen.getByLabelText("API key?") as HTMLInputElement;
	expect(field.type).toBe("password");
	expect(field.autocomplete).toBe("off");
	expect(field.getAttribute("aria-describedby")).toBeTruthy();
	expect(
		screen.getByText(/Hidden as you type\. It goes to Codex and is not shown/),
	).toBeTruthy();
	fireEvent.change(field, { target: { value: "sk-top-secret" } });
	// Typed text is in the field's value only, never in the page's text.
	expect(document.body.textContent).not.toContain("sk-top-secret");
	fireEvent.click(submit());
	expect(onAnswer).toHaveBeenCalledWith({ "API key?": "sk-top-secret" }, undefined);
});

test("a secret question with options gives Other a password field, hinted and never echoed", () => {
	const onAnswer = drawFor([
		{
			question: "Which key?",
			header: "Key",
			multiSelect: false,
			secret: true,
			options: [{ label: "Staging", description: "" }],
		},
	]);
	const other = screen.getByRole("radio", { name: "Other" });
	fireEvent.pointerDown(other);
	fireEvent.click(other);
	const field = screen.getByLabelText("Your own answer") as HTMLInputElement;
	expect(field.type).toBe("password");
	expect(field.autocomplete).toBe("off");
	expect(field.getAttribute("aria-describedby")).toBeTruthy();
	expect(
		screen.getByText(/Hidden as you type\. It goes to Codex and is not shown/),
	).toBeTruthy();
	fireEvent.change(field, { target: { value: "sk-top-secret" } });
	expect(document.body.textContent).not.toContain("sk-top-secret");
	fireEvent.click(submit());
	expect(onAnswer).toHaveBeenCalledWith({ "Which key?": "sk-top-secret" }, undefined);
});

test("a question that is not secret keeps a plain text Other field with no hint", () => {
	drawFor([
		{
			question: "Which key?",
			header: "Key",
			multiSelect: true,
			options: [{ label: "Staging", description: "" }],
		},
	]);
	const other = screen.getByRole("checkbox", { name: "Other" });
	fireEvent.pointerDown(other);
	fireEvent.click(other);
	expect((screen.getByLabelText("Your own answer") as HTMLInputElement).type).toBe(
		"text",
	);
	expect(screen.queryByText(/Hidden as you type/)).toBeNull();
});

test("a question with no options can be skipped, and one with options still works", () => {
	const onAnswer = drawFor([FREE_TEXT]);
	fireEvent.click(screen.getByTestId("chat-question-skip"));
	expect(onAnswer).toHaveBeenCalledExactlyOnceWith({}, undefined);
	cleanup();
	// A free question after one with options moves the keyboard to its field.
	drawFor([QUESTION.questions[0] as ChatCardQuestion, FREE_TEXT]);
	fireEvent.click(screen.getByRole("radio", { name: /Grid/ }));
	fireEvent.click(next());
	expect(screen.getByRole("textbox", { name: FREE_TEXT.question })).toBeTruthy();
	expect(document.activeElement).toBe(
		screen.getByRole("textbox", { name: FREE_TEXT.question }),
	);
});

test("Claude's question card names Claude", () => {
	drawFor([QUESTION.questions[0] as ChatCardQuestion], "claude");
	expect(screen.getByRole("region", { name: "Claude's question" })).toBeTruthy();
	cleanup();
	drawFor([...QUESTION.questions], "claude");
	expect(screen.getByRole("region", { name: "Claude's questions" })).toBeTruthy();
});

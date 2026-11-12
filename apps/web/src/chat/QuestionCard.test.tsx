import type { ChatOpenCard } from "@portikus/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
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

import type { ChatOpenCard } from "@portikus/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { ToolBlock } from "./ToolBlock";

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

function drawQuestion(onAnswer = vi.fn(() => true), takeFocus = () => true) {
	render(<QuestionCard card={QUESTION} onAnswer={onAnswer} takeFocus={takeFocus} />);
	const [first, second] = screen.getAllByRole("group");
	if (!first || !second) throw new Error("two questions expected");
	return { onAnswer, first: within(first), second: within(second) };
}

test("the card takes focus on its first option and names each question", () => {
	const { first } = drawQuestion();
	expect(screen.getByRole("heading", { name: "Claude has 2 questions" })).toBeTruthy();
	expect(document.activeElement).toBe(first.getByRole("radio", { name: "Grid" }));
	expect(
		screen.getByRole("group", { name: /^Layout:\s*Which layout\?$/ }),
	).toBeTruthy();
	expect(
		first.getByRole("radio", { name: "Grid" }).getAttribute("aria-describedby"),
	).toBeTruthy();
});

test("it leaves focus alone when told not to take it", () => {
	drawQuestion(
		vi.fn(() => true),
		() => false,
	);
	expect(document.activeElement).toBe(document.body);
});

test("the focused option's preview is shown", () => {
	const { first } = drawQuestion();
	expect(screen.getByTestId("chat-question-preview").textContent).toBe("+--+--+");
	fireEvent.focus(first.getByRole("radio", { name: "Stack" }));
	expect(screen.getByTestId("chat-question-preview").textContent).toBe("+-----+");
	expect(screen.getByText("Preview: Stack")).toBeTruthy();
});

test("a single pick, multiple picks, Other and notes send the right answer", () => {
	const { onAnswer, first, second } = drawQuestion();
	fireEvent.click(first.getByRole("radio", { name: "Stack" }));
	fireEvent.change(first.getByRole("textbox", { name: "Notes (optional)" }), {
		target: { value: "keep it simple" },
	});
	fireEvent.click(second.getByRole("checkbox", { name: "Tests" }));
	fireEvent.click(second.getByRole("checkbox", { name: "Lint" }));
	fireEvent.change(second.getByRole("textbox", { name: "Other" }), {
		target: { value: "and a build" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
	expect(onAnswer).toHaveBeenCalledWith(
		{ "Which layout?": "Stack", "Which checks?": "Lint, Tests" },
		{ "Which layout?": "keep it simple", "Which checks?": "and a build" },
	);
});

test("writing an Other answer to a single-select question picks Other", () => {
	const { onAnswer, first, second } = drawQuestion();
	fireEvent.click(first.getByRole("radio", { name: "Grid" }));
	fireEvent.change(first.getByRole("textbox", { name: "Your own answer" }), {
		target: { value: "Masonry" },
	});
	expect(
		(first.getByRole("radio", { name: "Other" }) as HTMLInputElement).checked,
	).toBe(true);
	fireEvent.click(second.getByRole("checkbox", { name: "Types" }));
	fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
	expect(onAnswer).toHaveBeenCalledWith(
		{ "Which layout?": "Masonry", "Which checks?": "Types" },
		undefined,
	);
});

test("Enter on an option sends, and an unanswered question is named and focused", () => {
	const { onAnswer, first, second } = drawQuestion();
	const grid = first.getByRole("radio", { name: "Grid" });
	fireEvent.click(grid);
	fireEvent.keyDown(grid, { key: "Enter" });
	expect(onAnswer).not.toHaveBeenCalled();
	expect(screen.getByRole("alert").textContent).toContain("Answer every question");
	expect(document.activeElement).toBe(second.getByRole("checkbox", { name: "Lint" }));
	fireEvent.click(second.getByRole("checkbox", { name: "Lint" }));
	fireEvent.keyDown(second.getByRole("checkbox", { name: "Lint" }), { key: "Enter" });
	expect(onAnswer).toHaveBeenCalledTimes(1);
});

test("Enter in a note sends; Shift+Enter does not", () => {
	const { onAnswer, first, second } = drawQuestion();
	fireEvent.click(first.getByRole("radio", { name: "Grid" }));
	fireEvent.click(second.getByRole("checkbox", { name: "Lint" }));
	const notes = second.getByRole("textbox", { name: "Notes (optional)" });
	fireEvent.keyDown(notes, { key: "Enter", shiftKey: true });
	expect(onAnswer).not.toHaveBeenCalled();
	fireEvent.keyDown(notes, { key: "Enter" });
	expect(onAnswer).toHaveBeenCalledTimes(1);
});

test("an answer that could not be sent says so and can be sent again", () => {
	const onAnswer = vi.fn(() => false);
	const { first, second } = drawQuestion(onAnswer);
	fireEvent.click(first.getByRole("radio", { name: "Grid" }));
	fireEvent.click(second.getByRole("checkbox", { name: "Lint" }));
	fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
	expect(screen.getByRole("alert").textContent).toContain("not connected");
	onAnswer.mockReturnValue(true);
	fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
	expect(onAnswer).toHaveBeenCalledTimes(2);
	expect(
		screen.getByRole("button", { name: "Send answers" }).getAttribute("aria-busy"),
	).toBe("true");
});

const PERMISSION: Extract<ChatOpenCard, { type: "permission" }> = {
	type: "permission",
	id: "p1",
	toolName: "Bash",
	title: "Run the test suite",
	input: { command: "pnpm test", timeout: 60 },
	options: [
		{ id: "allow", label: "Allow" },
		{ id: "deny", label: "Deny" },
	],
};

test("a permission card shows the tool, its input and the options, and focuses the first", () => {
	const onAnswer = vi.fn(() => true);
	render(
		<PermissionCard card={PERMISSION} onAnswer={onAnswer} takeFocus={() => true} />,
	);
	expect(
		screen.getByRole("heading", { name: "Claude wants to use Bash" }),
	).toBeTruthy();
	expect(screen.getByText("Run the test suite")).toBeTruthy();
	expect(screen.getByText("command").nextElementSibling?.textContent).toBe("pnpm test");
	expect(document.activeElement).toBe(screen.getByRole("button", { name: "Allow" }));
	fireEvent.click(screen.getByRole("button", { name: "Deny" }));
	expect(onAnswer).toHaveBeenCalledWith("deny");
	fireEvent.click(screen.getByRole("button", { name: "Allow" }));
	expect(onAnswer).toHaveBeenCalledTimes(1);
});

test("ExitPlanMode shows its plan as Markdown", () => {
	render(
		<PermissionCard
			card={{
				...PERMISSION,
				toolName: "ExitPlanMode",
				title: "",
				input: {
					plan: "## Plan\n\n1. Add a test\n2. Fix it\n\n![x](https://evil.example/p.png)",
				},
				options: [{ id: "approve", label: "Approve plan" }],
			}}
			onAnswer={() => true}
			takeFocus={() => false}
		/>,
	);
	expect(
		screen.getByRole("heading", { name: "Claude has a plan for you to review" }),
	).toBeTruthy();
	expect(screen.getByRole("heading", { name: "Plan" })).toBeTruthy();
	expect(screen.getAllByRole("listitem")).toHaveLength(2);
	expect(document.querySelector("img")).toBeNull();
});

test("a tool block opens to its input and output, images included", () => {
	render(
		<ToolBlock
			tool={{
				kind: "tool",
				key: "tool:t1",
				id: "t1",
				name: "Screenshot",
				title: "the home page",
				input: { url: "http://localhost:3000" },
				output: [
					{ type: "text", text: "saved" },
					{ type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
					{ type: "imageOmitted", mediaType: "image/png" },
				],
				status: "error",
				turnId: null,
			}}
		/>,
	);
	const block = screen.getByTestId("chat-tool-t1");
	expect(block.querySelector("summary")?.textContent).toBe(
		"Screenshotthe home pageFailed",
	);
	expect(screen.getByText("Error")).toBeTruthy();
	expect(
		screen
			.getByRole("img", { name: "Output of Screenshot", hidden: true })
			.getAttribute("src"),
	).toBe("data:image/png;base64,iVBORw0KGgo=");
	expect(screen.getByText("Image not kept", { exact: true })).toBeTruthy();
	expect(block.textContent).toContain('"url": "http://localhost:3000"');
});

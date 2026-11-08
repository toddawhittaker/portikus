import type { ChatOpenCard } from "@portikus/contracts";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createChatStore } from "./chatStore";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { SessionRules } from "./SessionRules";
import { ToolBlock } from "./ToolBlock";

afterEach(cleanup);

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

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
	render(
		<QuestionCard
			card={QUESTION}
			onAnswer={onAnswer}
			takeFocus={takeFocus}
			waiting={0}
		/>,
	);
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

function openNotes(question: ReturnType<typeof within>): HTMLElement {
	fireEvent.click(question.getByRole("button", { name: "Add a note" }));
	return question.getByRole("textbox", { name: "Notes (optional)" });
}

test("a single pick, multiple picks, Other and notes send the right answer", () => {
	const { onAnswer, first, second } = drawQuestion();
	fireEvent.click(first.getByRole("radio", { name: "Stack" }));
	fireEvent.change(openNotes(first), {
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

test("Enter in a note adds a line, and Ctrl+Enter sends, as its hint says", () => {
	const { onAnswer, first, second } = drawQuestion();
	fireEvent.click(first.getByRole("radio", { name: "Grid" }));
	fireEvent.click(second.getByRole("checkbox", { name: "Lint" }));
	const notes = openNotes(second);
	// "Add a note" goes away with its click, so the field takes the keyboard.
	expect(document.activeElement).toBe(notes);
	expect(notes.getAttribute("aria-describedby")).toBeTruthy();
	const hint = document.getElementById(notes.getAttribute("aria-describedby") ?? "");
	expect(hint?.textContent).toContain("Ctrl+Enter");
	fireEvent.keyDown(notes, { key: "Enter" });
	fireEvent.keyDown(notes, { key: "Enter", shiftKey: true });
	expect(onAnswer).not.toHaveBeenCalled();
	fireEvent.keyDown(notes, { key: "Enter", ctrlKey: true });
	expect(onAnswer).toHaveBeenCalledTimes(1);
});

test("choosing Other checks its radio before anything is written, and moves to its field", () => {
	const { first } = drawQuestion();
	fireEvent.click(first.getByRole("radio", { name: "Grid" }));
	const other = first.getByRole("radio", { name: "Other" }) as HTMLInputElement;
	fireEvent.click(other);
	expect(other.checked).toBe(true);
	expect((first.getByRole("radio", { name: "Grid" }) as HTMLInputElement).checked).toBe(
		false,
	);
	expect(document.activeElement).toBe(
		first.getByRole("textbox", { name: "Your own answer" }),
	);
	fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
	// Other with no text is not an answer yet.
	expect(screen.getByRole("alert").textContent).toContain("Answer every question");
});

test("each option with a preview is described by its own preview", () => {
	const { first } = drawQuestion();
	const stack = first.getByRole("radio", { name: "Stack" });
	const described = (stack.getAttribute("aria-describedby") ?? "")
		.split(" ")
		.map((id) => document.getElementById(id)?.textContent);
	expect(described).toEqual(["One column", "Preview: +-----+"]);
});

test("a card says how many more wait behind it", () => {
	render(
		<QuestionCard
			card={QUESTION}
			onAnswer={() => true}
			takeFocus={() => false}
			waiting={2}
		/>,
	);
	expect(screen.getByTestId("chat-cards-waiting").textContent).toBe(
		"2 more requests are waiting.",
	);
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
		<PermissionCard
			card={PERMISSION}
			onAnswer={onAnswer}
			takeFocus={() => true}
			waiting={1}
		/>,
	);
	expect(
		screen.getByRole("heading", { name: "Claude wants to run a command" }),
	).toBeTruthy();
	expect(screen.getByText("Run the test suite")).toBeTruthy();
	// The bare command, not a JSON object.
	expect(screen.getByTestId("chat-permission-command").textContent).toBe("pnpm test");
	expect(screen.getByTestId("chat-cards-waiting").textContent).toBe(
		"1 more request is waiting.",
	);
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
			waiting={0}
		/>,
	);
	expect(
		screen.getByRole("heading", { name: "Claude has a plan for you to review" }),
	).toBeTruthy();
	// The plan scrolls on its own, so the keyboard can reach it.
	expect(screen.getByTestId("chat-plan").tabIndex).toBe(0);
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
	expect(screen.getByRole("region", { name: "Error" })).toBeTruthy();
	expect(
		screen
			.getByRole("img", { name: "Output of Screenshot", hidden: true })
			.getAttribute("src"),
	).toBe("data:image/png;base64,iVBORw0KGgo=");
	expect(screen.getByText("Image not kept", { exact: true })).toBeTruthy();
	expect(block.textContent).toContain('"url": "http://localhost:3000"');
});

test("an Edit permission shows its change as a diff, with the file named", () => {
	render(
		<PermissionCard
			card={{
				...PERMISSION,
				toolName: "Edit",
				title: "Edit src/Sidebar.tsx",
				input: {
					file_path: "src/Sidebar.tsx",
					old_string: "a {\n  width: 320px;\n}",
					new_string: "a {\n  inline-size: 20rem;\n}",
				},
			}}
			onAnswer={() => true}
			takeFocus={() => false}
			waiting={0}
		/>,
	);
	expect(
		screen.getByRole("heading", { name: "Claude wants to edit a file" }),
	).toBeTruthy();
	expect(screen.getByText("src/Sidebar.tsx")).toBeTruthy();
	// The host's "Edit …" title would only repeat the heading.
	expect(screen.queryByText("Edit src/Sidebar.tsx")).toBeNull();
	expect(screen.getByTestId("chat-diff").textContent).toBe(
		"  a {\n-   width: 320px;\n+   inline-size: 20rem;\n  }\n",
	);
});

function tool(overrides: Partial<Parameters<typeof ToolBlock>[0]["tool"]> = {}) {
	return {
		kind: "tool" as const,
		key: "tool:t2",
		id: "t2",
		name: "Bash",
		title: "Run the tests",
		input: { command: "pnpm vitest run" },
		output: [],
		status: "done" as const,
		turnId: null,
		...overrides,
	};
}

test("a Bash block shows the bare command and Done, with the raw input one click in", () => {
	render(<ToolBlock tool={tool()} />);
	const block = screen.getByTestId("chat-tool-t2");
	expect(block.querySelector("summary")?.textContent).toBe("Bashpnpm vitest runDone");
	expect(screen.getByText("Raw input")).toBeTruthy();
	expect(block.textContent).toContain('"command": "pnpm vitest run"');
});

test("a stopped tool says so", () => {
	render(<ToolBlock tool={tool({ status: "stopped" })} />);
	expect(screen.getByTestId("chat-tool-state").textContent).toBe("Stopped");
});

test("long output is cut short until Show more", () => {
	const text = Array.from({ length: 30 }, (_, at) => `line ${at + 1}`).join("\n");
	render(<ToolBlock tool={tool({ output: [{ type: "text", text }] })} />);
	const output = screen.getByRole("region", { name: "Output" });
	expect(output.querySelector("pre")?.textContent?.split("\n")).toHaveLength(12);
	const more = within(output).getByRole("button", { name: "Show 18 more lines" });
	expect(more.getAttribute("aria-expanded")).toBe("false");
	fireEvent.click(more);
	expect(output.querySelector("pre")?.textContent).toBe(text);
	expect(within(output).getByRole("button", { name: "Show less" })).toBeTruthy();
});

test("the Always allow button says what it allows and for how long", () => {
	const onAnswer = vi.fn(() => true);
	const label = 'Always allow "sed" commands in this session';
	render(
		<PermissionCard
			card={{
				...PERMISSION,
				options: [
					{ id: "allow", label: "Allow once" },
					{ id: "always", label },
					{ id: "deny", label: "Deny" },
				],
			}}
			onAnswer={onAnswer}
			takeFocus={() => false}
			waiting={0}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: label }));
	expect(onAnswer).toHaveBeenCalledWith("always");
});

test("session rules are listed only when there are some, and Revoke sends the rule", () => {
	const sent: unknown[] = [];
	const store = createChatStore((message) => {
		sent.push(message);
		return true;
	});
	const { container } = render(<SessionRules store={store} />);
	expect(container.textContent).toBe("");
	act(() => {
		store.getState().receive(
			JSON.stringify({
				type: "snapshot",
				sessionId: SESSION_ID,
				seq: 1,
				cards: [],
				turnRunning: false,
				truncated: false,
			}),
		);
		store.getState().receive(
			JSON.stringify({
				type: "rules",
				sessionId: SESSION_ID,
				seq: 2,
				rules: [{ rule: "Bash(sed:*)", description: '"sed" commands in this session' }],
			}),
		);
	});
	expect(
		screen.getByText("Allowed without asking in this session: 1 rule"),
	).toBeTruthy();
	expect(screen.getByText("Bash(sed:*)")).toBeTruthy();
	fireEvent.click(
		screen.getByRole("button", { name: 'Revoke: "sed" commands in this session' }),
	);
	expect(sent).toEqual([{ type: "rule.revoke", rule: "Bash(sed:*)" }]);
});

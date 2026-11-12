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
import {
	AgentStatusContext,
	createAgentStatusStore,
} from "../terminal/codingAgentStatus";
import { createChatStore } from "./chatStore";
import { PermissionCard } from "./PermissionCard";
import { SessionRules } from "./SessionRules";
import { ToolBlock } from "./ToolBlock";

afterEach(cleanup);

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

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
	fireEvent.click(screen.getByRole("button", { name: "Allow" }));
	expect(onAnswer).toHaveBeenCalledWith("allow", {});
	fireEvent.click(screen.getByRole("button", { name: "Deny" }));
	expect(onAnswer).toHaveBeenCalledTimes(1);
});

function renderCard(card = PERMISSION) {
	const onAnswer = vi.fn((_id: string, _extras?: object) => true);
	render(
		<PermissionCard
			card={card}
			onAnswer={onAnswer}
			takeFocus={() => true}
			waiting={0}
		/>,
	);
	return onAnswer;
}

test("Deny opens the reason field, and Enter sends the typed text as the message", () => {
	const onAnswer = renderCard();
	fireEvent.click(screen.getByRole("button", { name: /Deny/ }));
	expect(onAnswer).not.toHaveBeenCalled();
	const field = screen.getByLabelText("Tell Claude what to do instead");
	expect(document.activeElement).toBe(field);
	// Digits are text here, not option keys.
	fireEvent.keyDown(field, { key: "1" });
	fireEvent.change(field, { target: { value: "  use pnpm 1 instead  " } });
	fireEvent.submit(field.closest("form") as HTMLFormElement);
	expect(onAnswer).toHaveBeenCalledExactlyOnceWith("deny", {
		message: "use pnpm 1 instead",
	});
});

test("an empty reason sends a plain denial", () => {
	const onAnswer = renderCard();
	fireEvent.keyDown(screen.getByRole("button", { name: /Allow/ }), { key: "2" });
	fireEvent.click(screen.getByTestId("chat-deny-send"));
	expect(onAnswer).toHaveBeenCalledExactlyOnceWith("deny", {});
});

test("Escape in the reason field goes back to the buttons without answering", () => {
	const onAnswer = renderCard();
	fireEvent.click(screen.getByRole("button", { name: /Deny/ }));
	fireEvent.keyDown(screen.getByLabelText("Tell Claude what to do instead"), {
		key: "Escape",
	});
	expect(screen.queryByLabelText("Tell Claude what to do instead")).toBeNull();
	expect(screen.getByRole("button", { name: /Deny/ })).toBeTruthy();
	expect(onAnswer).not.toHaveBeenCalled();
});

test("Back, or Escape anywhere in the form, restores the options with focus on Deny", async () => {
	const onAnswer = renderCard();
	fireEvent.click(screen.getByRole("button", { name: /Deny/ }));
	fireEvent.click(screen.getByRole("button", { name: "Back" }));
	expect(screen.queryByLabelText("Tell Claude what to do instead")).toBeNull();
	await vi.waitFor(() =>
		expect(document.activeElement).toBe(screen.getByRole("button", { name: /Deny/ })),
	);
	fireEvent.click(screen.getByRole("button", { name: /Deny/ }));
	fireEvent.keyDown(screen.getByTestId("chat-deny-send"), { key: "Escape" });
	expect(screen.queryByLabelText("Tell Claude what to do instead")).toBeNull();
	expect(onAnswer).not.toHaveBeenCalled();
});

test("plan approval sends only the option, and keep planning takes a reason", () => {
	const plan: typeof PERMISSION = {
		...PERMISSION,
		toolName: "ExitPlanMode",
		input: { plan: "1. do it" },
		options: [
			{ id: "allow-accept-edits", label: "Yes, and accept edits" },
			{ id: "allow-ask-edits", label: "Yes, and ask before edits" },
			{ id: "deny", label: "No, keep planning" },
		],
	};
	const first = renderCard(plan);
	fireEvent.click(screen.getByRole("button", { name: /accept edits/ }));
	expect(first).toHaveBeenCalledWith("allow-accept-edits", {});
	cleanup();
	const second = renderCard(plan);
	fireEvent.click(screen.getByRole("button", { name: /ask before edits/ }));
	expect(second).toHaveBeenCalledWith("allow-ask-edits", {});
	cleanup();
	const third = renderCard(plan);
	fireEvent.click(screen.getByRole("button", { name: /keep planning/ }));
	fireEvent.change(screen.getByLabelText("Tell Claude what to do instead"), {
		target: { value: "add tests" },
	});
	fireEvent.click(screen.getByTestId("chat-deny-send"));
	expect(third).toHaveBeenCalledWith("deny", { message: "add tests" });
});

test("an edit permission names the file's language above its diff", () => {
	renderCard({
		...PERMISSION,
		toolName: "Edit",
		input: { file_path: "src/app.ts", old_string: "a", new_string: "b" },
	});
	expect(document.querySelector(".pk-chat-lang")?.textContent).toBe("TypeScript");
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
		"Screenshot the home pageFailed",
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

test("a Bash block says what it ran, with the raw input one click in", () => {
	render(<ToolBlock tool={tool()} />);
	const block = screen.getByTestId("chat-tool-t2");
	expect(block.querySelector("summary")?.textContent).toBe("Ran pnpm vitest run");
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
	expect(onAnswer).toHaveBeenCalledWith("always", {});
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

function rulesFrame(seq: number, rules: { rule: string; description: string }[]) {
	return JSON.stringify({ type: "rules", sessionId: SESSION_ID, seq, rules });
}

const SED = { rule: "Bash(sed:*)", description: '"sed" commands in this session' };
const GREP = { rule: "Bash(grep:*)", description: '"grep" commands in this session' };

function renderRules(transport: () => boolean = () => true) {
	const sent: unknown[] = [];
	const store = createChatStore((message) => {
		sent.push(message);
		return transport();
	});
	render(
		<div className="pk-chat">
			<SessionRules store={store} />
			<div className="pk-chat-composer">
				<div role="combobox" aria-expanded={false} tabIndex={0} aria-label="Message" />
			</div>
		</div>,
	);
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
		store.getState().receive(rulesFrame(2, [SED, GREP]));
	});
	return { store, sent };
}

const revokeButton = (rule: { description: string }) =>
	screen.getByRole("button", { name: `Revoke: ${rule.description}` });
const rulesStatus = () => screen.getByTestId("chat-session-rules-status").textContent;

test("Revoke is busy while it waits, so a second press sends nothing", () => {
	const { sent } = renderRules();
	fireEvent.click(revokeButton(SED));
	expect(revokeButton(SED).getAttribute("aria-busy")).toBe("true");
	expect(revokeButton(SED).getAttribute("aria-disabled")).toBe("true");
	fireEvent.click(revokeButton(SED));
	expect(sent).toEqual([{ type: "rule.revoke", rule: SED.rule }]);
});

test("after a revoke the next Revoke takes focus and the revoke is announced", () => {
	const { store } = renderRules();
	revokeButton(SED).focus();
	fireEvent.click(revokeButton(SED));
	act(() => store.getState().receive(rulesFrame(3, [GREP])));
	expect(document.activeElement).toBe(revokeButton(GREP));
	expect(rulesStatus()).toBe(`Revoked: ${SED.description}.`);
});

test("revoking the last row focuses the summary, and the last rule the message box", () => {
	const { store } = renderRules();
	revokeButton(GREP).focus();
	fireEvent.click(revokeButton(GREP));
	act(() => store.getState().receive(rulesFrame(3, [SED])));
	expect(document.activeElement?.tagName).toBe("SUMMARY");
	revokeButton(SED).focus();
	fireEvent.click(revokeButton(SED));
	act(() => store.getState().receive(rulesFrame(4, [])));
	expect(document.activeElement).toBe(
		screen.getByRole("combobox", { name: "Message" }),
	);
	expect(rulesStatus()).toBe(`Revoked: ${SED.description}.`);
});

test("a rule revoked from another browser leaves the focus alone and says nothing", () => {
	const { store } = renderRules();
	const box = screen.getByRole("combobox", { name: "Message" });
	box.focus();
	act(() => store.getState().receive(rulesFrame(3, [GREP])));
	expect(document.activeElement).toBe(box);
	expect(rulesStatus()).toBe("");
});

test("a list that still holds the rule ends the wait without saying it was revoked", () => {
	const { store } = renderRules();
	fireEvent.click(revokeButton(SED));
	act(() => store.getState().receive(rulesFrame(3, [SED, GREP])));
	expect(revokeButton(SED).getAttribute("aria-busy")).toBeNull();
	expect(rulesStatus()).toBe("");
});

test("a revoke that cannot be sent says so and leaves Revoke ready", () => {
	renderRules(() => false);
	fireEvent.click(revokeButton(SED));
	expect(screen.getByRole("alert").textContent).toContain("not connected");
	expect(revokeButton(SED).getAttribute("aria-busy")).toBeNull();
});

test("inside a permission card, 1, 2 and 3 choose its options, each showing its number", () => {
	const onAnswer = vi.fn(() => true);
	const three = {
		...PERMISSION,
		options: [
			{ id: "allow", label: "Allow" },
			{ id: "always", label: "Always allow pnpm test" },
			{ id: "deny", label: "Deny" },
		],
	};
	render(
		<PermissionCard
			card={three}
			onAnswer={onAnswer}
			takeFocus={() => true}
			waiting={0}
		/>,
	);
	const allow = screen.getByRole("button", { name: "Allow" });
	expect(allow.getAttribute("aria-keyshortcuts")).toBe("1");
	const deny = screen.getByRole("button", { name: "Deny" });
	expect(deny.getAttribute("aria-keyshortcuts")).toBe("3");
	expect(allow.textContent).toBe("1Allow");
	// A modified key, or a number with no option, does nothing.
	fireEvent.keyDown(allow, { key: "3", ctrlKey: true });
	fireEvent.keyDown(allow, { key: "4" });
	fireEvent.keyDown(allow, { key: "0" });
	expect(onAnswer).not.toHaveBeenCalled();
	fireEvent.keyDown(allow, { key: "2" });
	expect(onAnswer).toHaveBeenCalledWith("always", {});
	// Once chosen, another key cannot change the answer.
	fireEvent.keyDown(allow, { key: "1" });
	expect(onAnswer).toHaveBeenCalledTimes(1);
});

test("a number key from outside the card answers nothing", () => {
	const onAnswer = vi.fn(() => true);
	render(
		<>
			<input aria-label="Elsewhere" />
			<PermissionCard
				card={PERMISSION}
				onAnswer={onAnswer}
				takeFocus={() => false}
				waiting={0}
			/>
		</>,
	);
	fireEvent.keyDown(screen.getByRole("textbox", { name: "Elsewhere" }), { key: "1" });
	expect(onAnswer).not.toHaveBeenCalled();
});

const LAUNCH_TEXT =
	"Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it.)\nagentId: a1b2c3 (internal ID - do not mention to user.)\noutput_file: /tmp/claude-1000/a1b2c3.output Do NOT Read or tail this file";

function agentTool(overrides: Parameters<typeof tool>[0] = {}) {
	return tool({
		id: "toolu_bg",
		name: "Agent",
		title: "Find the login form",
		input: {
			description: "Find the login form",
			subagent_type: "Explore",
			prompt: "Find where the login form posts",
			run_in_background: true,
		},
		output: [{ type: "text", text: LAUNCH_TEXT }],
		...overrides,
	});
}

function renderWithSubagent(state: "working" | "finished" | null) {
	const store = createAgentStatusStore(() => true);
	store.update(
		[
			{
				terminalId: "term-1",
				agent: "claude",
				state: "working",
				since: "2026-11-11T10:00:00.000Z",
				subagents:
					state === null
						? []
						: [
								{
									id: "toolu_bg",
									type: "Explore",
									description: "Find the login form",
									state,
									since: "2026-11-11T10:00:00.000Z",
								},
							],
				projectId: "22222222-2222-4222-8222-222222222222",
				name: "Chat",
				kind: "chat",
			},
		],
		true,
	);
	render(
		<AgentStatusContext.Provider value={store}>
			<ToolBlock tool={agentTool()} />
		</AgentStatusContext.Provider>,
	);
}

test("a background Agent card says it started and shows no launch text or raw disclosure", () => {
	render(<ToolBlock tool={agentTool()} />);
	const block = screen.getByTestId("chat-tool-toolu_bg");
	expect(screen.getByTestId("chat-agent-status").textContent).toBe(
		"Started in the background",
	);
	// The prompt is shown in place of the model-only text.
	expect(block.textContent).toContain("Find where the login form posts");
	expect(screen.queryByRole("region", { name: "Output" })).toBeNull();
	expect(screen.queryByText("Raw output")).toBeNull();
	expect(screen.queryByText("Raw input")).toBeNull();
	// The launch text appears nowhere in the card, open or closed.
	expect(block.textContent).not.toContain("internal metadata");
	expect(block.textContent).not.toContain("Async agent launched");
	expect(block.textContent).not.toContain("agentId");
	expect(block.textContent).not.toContain("output_file");
});

test("a background Agent card takes the subagent's state from the project list", () => {
	renderWithSubagent("working");
	expect(screen.getByTestId("chat-agent-status").textContent).toBe(
		"Started in the background · working",
	);
	cleanup();
	renderWithSubagent("finished");
	expect(screen.getByTestId("chat-agent-status").textContent).toBe(
		"Started in the background · finished",
	);
});

test("a background Agent card with no reported subagent claims no state", () => {
	renderWithSubagent(null);
	expect(screen.getByTestId("chat-agent-status").textContent).toBe(
		"Started in the background",
	);
});

test("a launch is spotted by its text even when the input does not say so", () => {
	render(
		<ToolBlock
			tool={agentTool({
				input: { description: "Find the login form", prompt: "Find it" },
			})}
		/>,
	);
	expect(screen.getByTestId("chat-agent-status")).toBeTruthy();
	expect(screen.queryByText("Raw output")).toBeNull();
	expect(screen.getByTestId("chat-tool-toolu_bg").textContent).not.toContain(
		"internal metadata",
	);
});

test("a foreground Agent card shows its final reply as before", () => {
	render(
		<ToolBlock
			tool={agentTool({
				input: { description: "Find the login form", prompt: "Find it" },
				output: [{ type: "text", text: "It posts to /api/session." }],
			})}
		/>,
	);
	expect(screen.queryByTestId("chat-agent-status")).toBeNull();
	expect(screen.queryByText("Raw output")).toBeNull();
	expect(screen.queryByText("Raw input")).toBeNull();
	expect(screen.getByRole("region", { name: "Output" }).textContent).toContain(
		"It posts to /api/session.",
	);
});

test("a background launch that failed shows its error, not a status", () => {
	render(
		<ToolBlock
			tool={agentTool({
				status: "error",
				output: [{ type: "text", text: "Unknown agent type" }],
			})}
		/>,
	);
	expect(screen.queryByTestId("chat-agent-status")).toBeNull();
	expect(screen.getByRole("region", { name: "Error" }).textContent).toContain(
		"Unknown agent type",
	);
	expect(screen.queryByText("Raw input")).toBeNull();
});

test("a background Agent still launching says so", () => {
	render(<ToolBlock tool={agentTool({ status: "running", output: [] })} />);
	expect(screen.getByTestId("chat-agent-status").textContent).toBe(
		"Starting in the background",
	);
});

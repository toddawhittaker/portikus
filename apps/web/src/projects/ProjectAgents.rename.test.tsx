import type { CodingAgentTerminal } from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { ProjectAgents } from "./ProjectAgents.js";

/**
 * A chat's row shows its conversation title and a pencil that renames it in
 * place: Enter saves, Escape cancels (SPEC.md §8.2, ADR 0074).
 */

const CHAT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TUI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		to: _to,
		params: _params,
		search: _search,
		...rest
	}: React.AnchorHTMLAttributes<HTMLAnchorElement> & Record<string, unknown>) => (
		<a href="#row" {...rest}>
			{children}
		</a>
	),
}));

let renames: {
	title: string;
	finish: ReturnType<typeof vi.fn>;
	fail: (e: Error) => void;
}[];

vi.mock("./renameChat.js", () => ({
	renameChat: (_workspace: string, _terminal: string, title: string) => {
		let fail: (error: Error) => void = () => undefined;
		let resolve: () => void = () => undefined;
		const done = new Promise<void>((res, rej) => {
			resolve = res;
			fail = rej;
		});
		const finish = vi.fn(() => resolve());
		renames.push({ title, finish, fail });
		return { done, finish };
	},
}));

beforeEach(() => {
	renames = [];
});

function terminal(overrides: Partial<CodingAgentTerminal>): CodingAgentTerminal {
	return {
		terminalId: CHAT,
		projectId: "p1",
		name: "Chat 1",
		kind: "chat",
		agent: "claude",
		state: "finished",
		since: new Date().toISOString(),
		subagents: [],
		...overrides,
	};
}

function show(terminals: CodingAgentTerminal[]) {
	const ui = (list: CodingAgentTerminal[]) => (
		<ToastProvider>
			<ProjectAgents
				workspaceId="w1"
				projectId="p1"
				projectName="todo"
				listId="agents-p1"
				expanded={true}
				terminals={list}
				unread={new Set()}
				currentTabId={null}
			/>
		</ToastProvider>
	);
	const view = render(ui(terminals));
	return { rerender: (list: CodingAgentTerminal[]) => view.rerender(ui(list)) };
}

test("a chat's title sits under its name, and only the chat has a pencil", () => {
	show([
		terminal({ title: "Fix the login redirect" }),
		terminal({ terminalId: TUI, kind: "terminal" }),
	]);
	const row = screen.getByTestId(`agent-row-${CHAT}`);
	expect(row.textContent).toContain("Claude Code (GUI)");
	expect(row.textContent).toContain("Fix the login redirect");
	expect(screen.getByTestId(`agent-rename-${CHAT}`).getAttribute("aria-label")).toBe(
		"Rename Fix the login redirect",
	);
	expect(screen.queryByTestId(`agent-rename-${TUI}`)).toBeNull();
	expect(screen.queryByTestId(`agent-title-${TUI}`)).toBeNull();
});

test("Enter saves a cleaned title, shown at once and kept until the status carries it", async () => {
	const view = show([terminal({})]);
	fireEvent.click(screen.getByTestId(`agent-rename-${CHAT}`));
	const input = screen.getByRole("textbox", { name: "Title of Claude Code (GUI)" });
	expect(document.activeElement).toBe(input);
	fireEvent.change(input, { target: { value: "  Grade\tthe   quiz " } });
	fireEvent.submit(input);
	expect(renames.map((one) => one.title)).toEqual(["Grade the quiz"]);
	expect(screen.getByTestId(`agent-title-${CHAT}`).textContent).toBe("Grade the quiz");
	view.rerender([terminal({ title: "Grade the quiz" })]);
	expect(renames[0]?.finish).toHaveBeenCalled();
	await act(async () => undefined);
	expect(screen.getByTestId(`agent-title-${CHAT}`).textContent).toBe("Grade the quiz");
});

test("Escape cancels, and an unchanged or empty title sends nothing", () => {
	show([terminal({ title: "Same" })]);
	fireEvent.click(screen.getByTestId(`agent-rename-${CHAT}`));
	fireEvent.keyDown(screen.getByTestId("agent-title-input"), { key: "Escape" });
	expect(screen.queryByTestId("agent-title-input")).toBeNull();
	fireEvent.click(screen.getByTestId(`agent-rename-${CHAT}`));
	fireEvent.submit(screen.getByTestId("agent-title-input"));
	fireEvent.click(screen.getByTestId(`agent-rename-${CHAT}`));
	const input = screen.getByTestId("agent-title-input");
	fireEvent.change(input, { target: { value: " \t " } });
	fireEvent.submit(input);
	expect(renames).toEqual([]);
});

test("a rename the host refuses puts the old title back and says why", async () => {
	show([terminal({ title: "Old" })]);
	fireEvent.click(screen.getByTestId(`agent-rename-${CHAT}`));
	const input = screen.getByTestId("agent-title-input");
	fireEvent.change(input, { target: { value: "New" } });
	fireEvent.submit(input);
	expect(screen.getByTestId(`agent-title-${CHAT}`).textContent).toBe("New");
	await act(async () => renames[0]?.fail(new Error("That chat has ended.")));
	expect(screen.getByTestId(`agent-title-${CHAT}`).textContent).toBe("Old");
	expect(await screen.findByText("The chat was not renamed")).toBeDefined();
	expect(screen.getByText("That chat has ended.")).toBeDefined();
});

test("a chat's subagent row opens that subagent's view; a terminal's does not", async () => {
	const { takeSubagentRequest } = await import("../chat/subagentView.js");
	const subagent = {
		id: "toolu_sub",
		type: "Explore",
		description: "Find the login form",
		state: "working" as const,
		since: new Date().toISOString(),
	};
	show([
		terminal({ subagents: [subagent] }),
		terminal({
			terminalId: TUI,
			kind: "terminal",
			subagents: [{ ...subagent, id: "toolu_tui" }],
		}),
	]);
	fireEvent.click(screen.getByTestId("subagent-row-toolu_sub"));
	fireEvent.click(screen.getByTestId("subagent-row-toolu_tui"));
	expect(takeSubagentRequest(CHAT)).toEqual({
		toolUseId: "toolu_sub",
		title: "Find the login form",
	});
	expect(takeSubagentRequest(TUI)).toBeUndefined();
});

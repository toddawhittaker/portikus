import type { Terminal } from "@portikus/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { shortenPath, TerminalLeaf } from "./TerminalLeaf";

// The pane itself is covered by TerminalPane.test.tsx; here it would only drag
// xterm.js and a WebSocket into the test.
vi.mock("../TerminalPane", () => ({
	TerminalPane: ({
		terminal,
		onCwd,
	}: {
		terminal: Terminal;
		onCwd: (path: string) => void;
	}) => (
		<button
			type="button"
			data-testid={`terminal-pane-${terminal.id}`}
			onClick={() => onCwd("/home/student/projects/todo-api/src")}
		/>
	),
}));

afterEach(cleanup);

const terminal: Terminal = {
	id: "44444444-4444-4444-8444-444444444444",
	workspaceId: "22222222-2222-4222-8222-222222222222",
	name: "zsh",
	cwd: "/home/student/projects/todo-api",
	position: 0,
	projectId: "33333333-3333-4333-8333-333333333333",
	createdAt: "2026-01-01T00:00:00.000Z",
	endedAt: null,
	theme: "dark",
};

function renderLeaf(
	overrides: Partial<Terminal> = {},
	handlers: Record<string, ReturnType<typeof vi.fn>> = {},
) {
	const props = {
		onFocus: vi.fn(),
		onSplit: vi.fn(),
		onRename: vi.fn(),
		onSetTheme: vi.fn(),
		onClose: vi.fn(),
		onExited: vi.fn(),
		onReplace: vi.fn(),
		onSessionEnded: vi.fn(),
		onLeave: vi.fn(),
		...handlers,
	};
	render(
		<TerminalLeaf
			workspaceId={terminal.workspaceId}
			projectId="33333333-3333-4333-8333-333333333333"
			terminal={{ ...terminal, ...overrides }}
			visible={true}
			focused={false}
			onFocus={props.onFocus}
			onSplit={props.onSplit}
			onRename={props.onRename}
			onSetTheme={props.onSetTheme}
			onClose={props.onClose}
			onExited={props.onExited}
			onReplace={props.onReplace}
			onSessionEnded={props.onSessionEnded}
			onLeave={props.onLeave}
		/>,
	);
	return props;
}

test("the bar shows the name and the home-relative directory", () => {
	renderLeaf();
	expect(screen.getByText("zsh · ~/projects/todo-api")).toBeTruthy();
	expect(shortenPath("/home/student/projects/x")).toBe("~/projects/x");
	expect(shortenPath("/srv/elsewhere")).toBe("/srv/elsewhere");
});

test("the actions menu splits right and down", () => {
	const props = renderLeaf();
	fireEvent.pointerDown(screen.getByTestId(`terminal-actions-${terminal.id}`), {
		button: 0,
		ctrlKey: false,
	});
	fireEvent.click(screen.getByTestId("split-right"));
	expect(props.onSplit).toHaveBeenCalledWith(terminal.id, "row");

	fireEvent.pointerDown(screen.getByTestId(`terminal-actions-${terminal.id}`), {
		button: 0,
		ctrlKey: false,
	});
	fireEvent.click(screen.getByTestId("split-down"));
	expect(props.onSplit).toHaveBeenCalledWith(terminal.id, "column");
});

test("the actions menu closes the terminal", () => {
	const props = renderLeaf();
	fireEvent.pointerDown(screen.getByTestId(`terminal-actions-${terminal.id}`), {
		button: 0,
		ctrlKey: false,
	});
	fireEvent.click(screen.getByTestId("terminal-close"));
	expect(props.onClose).toHaveBeenCalledWith(terminal.id);
});

test("Rename swaps the title for a field and saves on Enter", () => {
	const props = renderLeaf();
	fireEvent.pointerDown(screen.getByTestId(`terminal-actions-${terminal.id}`), {
		button: 0,
		ctrlKey: false,
	});
	fireEvent.click(screen.getByTestId("terminal-rename"));
	const field = screen.getByTestId("terminal-rename-field");
	fireEvent.change(field, { target: { value: "server" } });
	fireEvent.keyDown(field, { key: "Enter" });
	expect(props.onRename).toHaveBeenCalledWith(terminal.id, "server");
});

test("an ended terminal keeps its pane and offers a new one", () => {
	const props = renderLeaf({ endedAt: "2026-01-02T00:00:00.000Z" });
	expect(screen.getByTestId(`terminal-ended-${terminal.id}`).textContent).toContain(
		"This terminal ended when the workspace stopped",
	);
	expect(screen.queryByTestId(`terminal-pane-${terminal.id}`)).toBeNull();
	fireEvent.click(screen.getByTestId("new-terminal-here"));
	expect(props.onReplace).toHaveBeenCalledWith(terminal.id);
});

test("the bar follows the directory the agent reports", () => {
	renderLeaf();
	expect(screen.getByText("zsh · ~/projects/todo-api")).toBeTruthy();
	fireEvent.click(screen.getByTestId(`terminal-pane-${terminal.id}`));
	expect(screen.getByText("zsh · ~/projects/todo-api/src")).toBeTruthy();
});

/** Issue #268: the pane menu is where one terminal changes its colours. */
test("the actions menu offers the other colour scheme for this terminal", () => {
	const props = renderLeaf();
	fireEvent.pointerDown(screen.getByTestId(`terminal-actions-${terminal.id}`), {
		button: 0,
		ctrlKey: false,
	});
	const toggle = screen.getByTestId("terminal-theme-toggle");
	// A dark terminal offers light, and the tooltip warns about running programs.
	expect(toggle.textContent).toBe("Light terminal");
	expect(toggle.getAttribute("title")).toContain("already running");
	fireEvent.click(toggle);
	expect(props.onSetTheme).toHaveBeenCalledWith(terminal.id, "light");
});

test("a light terminal offers dark", () => {
	const props = renderLeaf({ theme: "light" });
	fireEvent.pointerDown(screen.getByTestId(`terminal-actions-${terminal.id}`), {
		button: 0,
		ctrlKey: false,
	});
	const toggle = screen.getByTestId("terminal-theme-toggle");
	expect(toggle.textContent).toBe("Dark terminal");
	fireEvent.click(toggle);
	expect(props.onSetTheme).toHaveBeenCalledWith(terminal.id, "dark");
});

import { readFileSync } from "node:fs";
import type { Terminal } from "@portikus/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
	alone = false,
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
		onMoveToNewTab: vi.fn(),
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
			onMoveToNewTab={props.onMoveToNewTab}
			alone={alone}
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

/** Radix returns focus on a timeout, so wait that turn out before asserting. */
async function flushCloseFocus() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

test("dismissing the actions menu with the pointer does not focus it", async () => {
	renderLeaf();
	const trigger = screen.getByTestId(`terminal-actions-${terminal.id}`);
	fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
	await flushCloseFocus();
	expect(screen.getByRole("menu")).toBeTruthy();

	fireEvent.pointerDown(document.body, { button: 0, ctrlKey: false });
	await flushCloseFocus();

	expect(screen.queryByRole("menu")).toBeNull();
	expect(document.activeElement).not.toBe(trigger);
});

test("closing the actions menu from the keyboard focuses it", async () => {
	renderLeaf();
	const trigger = screen.getByTestId(`terminal-actions-${terminal.id}`);
	trigger.focus();
	fireEvent.keyDown(trigger, { key: "Enter" });
	expect(screen.getByRole("menu")).toBeTruthy();

	fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
	await flushCloseFocus();

	expect(screen.queryByRole("menu")).toBeNull();
	expect(document.activeElement).toBe(trigger);
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

/**
 * Issue #286: the pane carries its own colour scheme, so the --terminal-*
 * tokens that colour the title bar and the scrollbar come from this pane
 * rather than from the per-user default on the document.
 */
test("the pane carries the terminal's own colour scheme", () => {
	const paneId = `terminal-leaf-${terminal.id}`;
	renderLeaf();
	expect(screen.getByTestId(paneId).getAttribute("data-terminal-theme")).toBe("dark");
	cleanup();
	renderLeaf({ theme: "light" });
	expect(screen.getByTestId(paneId).getAttribute("data-terminal-theme")).toBe("light");
});

function openActions() {
	fireEvent.pointerDown(screen.getByTestId(`terminal-actions-${terminal.id}`), {
		button: 0,
		ctrlKey: false,
	});
}

/** Issue #370: a pane can leave its split without a drag (WCAG 2.5.7). */
test("Move to new tab moves this pane without a drag", () => {
	const props = renderLeaf();
	openActions();
	fireEvent.click(screen.getByTestId("terminal-move-to-new-tab"));
	expect(props.onMoveToNewTab).toHaveBeenCalledWith(terminal.id);
});

test("Move to new tab is disabled for a pane that is already alone in its tab", () => {
	renderLeaf({}, {}, true);
	openActions();
	const item = screen
		.getByTestId("terminal-move-to-new-tab")
		.closest('[role="menuitem"]');
	expect(item?.getAttribute("aria-disabled")).toBe("true");
});

/** Issue #359: the menu says how to leave the terminal and does it. */
test("Leave terminal names Alt+Shift+Q and leaves the terminal", async () => {
	const outside = document.createElement("button");
	document.body.append(outside);
	const props = renderLeaf({}, { onLeave: vi.fn(() => outside.focus()) });
	const trigger = screen.getByTestId(`terminal-actions-${terminal.id}`);
	trigger.focus();
	fireEvent.keyDown(trigger, { key: "Enter" });
	const item = screen.getByTestId("terminal-leave").closest('[role="menuitem"]');
	expect(item?.getAttribute("aria-keyshortcuts")).toBe("Alt+Shift+Q");
	fireEvent.click(screen.getByTestId("terminal-leave"));
	await flushCloseFocus();
	expect(props.onLeave).toHaveBeenCalled();
	// The menu does not pull the keyboard back to its trigger.
	expect(document.activeElement).toBe(outside);
	outside.remove();
});

/**
 * Issue #368: the focus ring follows the pane's own scheme, so it keeps 3:1
 * on a light terminal in a dark page and on a dark terminal in a light page.
 */
test("each terminal scheme sets its own focus colour", async () => {
	const css = readFileSync(`${import.meta.dirname}/work.css`, "utf8").replace(
		/\s+/g,
		" ",
	);
	expect(css).toContain('.pk-term[data-terminal-theme="light"] { --focus: #1b7a86; }');
	expect(css).toContain('.pk-term[data-terminal-theme="dark"] { --focus: #5fc3cf; }');
});

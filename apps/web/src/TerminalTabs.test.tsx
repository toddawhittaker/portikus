import type { Terminal } from "@portikus/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TerminalTabs } from "./TerminalTabs";

afterEach(cleanup);

function terminal(overrides: Partial<Terminal> = {}): Terminal {
	return {
		id: "33333333-3333-4333-8333-333333333333",
		workspaceId: "22222222-2222-4222-8222-222222222222",
		name: "zsh",
		cwd: "/home/student/projects/todo-api",
		position: 0,
		projectId: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		endedAt: null,
		...overrides,
	};
}

function renderTabs(terminals: Terminal[]) {
	const props = {
		terminals,
		activeId: terminals[0]?.id ?? null,
		onSelect: vi.fn(),
		onCreate: vi.fn(),
		onRename: vi.fn(),
		onClose: vi.fn(),
		onRestart: vi.fn(),
	};
	render(<TerminalTabs {...props} />);
	return props;
}

test("the plus button creates a terminal", () => {
	const props = renderTabs([terminal()]);
	fireEvent.click(screen.getByLabelText("New terminal"));
	expect(props.onCreate).toHaveBeenCalledOnce();
});

test("double-click renames, Enter saves", () => {
	const props = renderTabs([terminal()]);
	fireEvent.doubleClick(screen.getByRole("tab", { name: /zsh/ }));
	const input = screen.getByLabelText("Rename zsh");
	fireEvent.change(input, { target: { value: "tests" } });
	fireEvent.keyDown(input, { key: "Enter" });
	expect(props.onRename).toHaveBeenCalledWith(terminal().id, "tests");
});

test("Escape cancels a rename", () => {
	const props = renderTabs([terminal()]);
	fireEvent.doubleClick(screen.getByRole("tab", { name: /zsh/ }));
	const input = screen.getByLabelText("Rename zsh");
	fireEvent.change(input, { target: { value: "tests" } });
	fireEvent.keyDown(input, { key: "Escape" });
	expect(props.onRename).not.toHaveBeenCalled();
	expect(screen.getByRole("tab", { name: /zsh/ })).toBeDefined();
});

test("the close button closes a terminal", () => {
	const props = renderTabs([terminal()]);
	fireEvent.click(screen.getByLabelText("Close zsh"));
	expect(props.onClose).toHaveBeenCalledWith(terminal().id);
});

test("an ended terminal is marked ended and offers a new terminal", () => {
	const ended = terminal({ endedAt: "2026-01-01T01:00:00.000Z" });
	const props = renderTabs([ended]);
	expect(screen.getByTestId(`terminal-tab-${ended.id}`).className).toContain(
		"pk-terminal-tab--ended",
	);
	expect(screen.getByText("(ended)")).toBeDefined();
	fireEvent.click(screen.getByLabelText("New terminal like zsh"));
	expect(props.onRestart).toHaveBeenCalledWith(ended);
});

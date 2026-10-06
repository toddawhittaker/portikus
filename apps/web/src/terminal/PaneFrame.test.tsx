import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PaneFrame, type PaneFrameProps } from "./PaneFrame";

afterEach(cleanup);

function renderFrame(overrides: Partial<PaneFrameProps> = {}) {
	const props: PaneFrameProps = {
		terminalId: "t1",
		name: "root",
		title: "root · /",
		focused: false,
		ended: false,
		alone: false,
		moveTargets: [],
		onFocus: vi.fn(),
		onSplit: vi.fn(),
		onMoveToNewTab: vi.fn(),
		onMoveInto: vi.fn(),
		onResetSizes: vi.fn(),
		onLeave: vi.fn(),
		onClose: vi.fn(),
		children: <p data-testid="inside">shell</p>,
		...overrides,
	};
	render(<PaneFrame {...props} />);
	return props;
}

function openMenu() {
	fireEvent.pointerDown(screen.getByTestId("terminal-actions-t1"), {
		button: 0,
		ctrlKey: false,
	});
}

test("the frame shows its title and holds what it is given", () => {
	renderFrame();
	expect(screen.getByText("root · /")).toBeTruthy();
	expect(screen.getByTestId("inside")).toBeTruthy();
	expect(screen.getByLabelText("Terminal: root · /")).toBeTruthy();
});

test("without rename or theme actions the menu offers neither", () => {
	const props = renderFrame();
	openMenu();
	expect(screen.queryByTestId("terminal-rename")).toBeNull();
	expect(screen.queryByTestId("terminal-theme-toggle")).toBeNull();
	fireEvent.click(screen.getByTestId("terminal-close"));
	expect(props.onClose).toHaveBeenCalledWith("t1");
});

test("given rename and theme actions, the menu offers both", () => {
	const props = renderFrame({ onRename: vi.fn(), onSetTheme: vi.fn(), theme: "dark" });
	openMenu();
	fireEvent.click(screen.getByTestId("terminal-theme-toggle"));
	expect(props.onSetTheme).toHaveBeenCalledWith("t1", "light");
	openMenu();
	fireEvent.click(screen.getByTestId("terminal-rename"));
	const field = screen.getByTestId("terminal-rename-field");
	fireEvent.change(field, { target: { value: "admin" } });
	fireEvent.keyDown(field, { key: "Enter" });
	expect(props.onRename).toHaveBeenCalledWith("t1", "admin");
});

test("an ended pane cannot be split, and a lone pane cannot move to a new tab", () => {
	renderFrame({ ended: true, alone: true });
	openMenu();
	const disabled = (id: string) =>
		screen.getByTestId(id).closest("[role='menuitem']")?.getAttribute("data-disabled");
	expect(disabled("split-right")).not.toBeNull();
	expect(disabled("terminal-move-to-new-tab")).not.toBeNull();
});

test("a drop zone is shaded on the edge a drag would land", () => {
	renderFrame({ dropEdge: "left" });
	expect(screen.getByTestId("drop-zone-t1").getAttribute("data-edge")).toBe("left");
});

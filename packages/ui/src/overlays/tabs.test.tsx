import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type TabItem, Tabs } from "./tabs";

const TABS: TabItem[] = [
	{ id: "t1", kind: "terminal", label: "zsh — todo-api" },
	{ id: "t2", kind: "file", label: "app.ts", dirty: true },
	{ id: "t3", kind: "terminal", label: "zsh — old", ended: true },
];

function renderTabs(overrides: Partial<React.ComponentProps<typeof Tabs>> = {}) {
	const props = {
		tabs: TABS,
		activeId: "t1",
		onSelect: vi.fn(),
		onClose: vi.fn(),
		onReorder: vi.fn(),
		...overrides,
	};
	render(<Tabs {...props} actions={<button type="button">Launcher</button>} />);
	return props;
}

describe("Tabs", () => {
	it("renders every tab and the launcher slot", () => {
		renderTabs();

		expect(screen.getAllByRole("tab")).toHaveLength(3);
		expect(screen.getByText("Launcher")).toBeTruthy();
		expect(screen.getByRole("tab", { selected: true }).textContent).toContain(
			"zsh — todo-api",
		);
	});

	it("selects a tab on click and on Enter", () => {
		const props = renderTabs();

		fireEvent.mouseDown(screen.getByRole("tab", { name: /app.ts/ }), { button: 0 });
		expect(props.onSelect).toHaveBeenCalledWith("t2");

		fireEvent.keyDown(screen.getByRole("tab", { name: /app.ts/ }), { key: "Enter" });
		expect(props.onSelect).toHaveBeenLastCalledWith("t2");
	});

	it("moves the focused tab with Alt+Shift+Right and announces it", () => {
		const props = renderTabs();

		fireEvent.keyDown(screen.getByRole("tab", { name: /zsh — todo-api/ }), {
			key: "ArrowRight",
			altKey: true,
			shiftKey: true,
		});

		expect(props.onReorder).toHaveBeenCalledWith(0, 1);
		const live = document.querySelector("[aria-live='polite']");
		expect(live?.textContent).toBe("zsh — todo-api moved to position 2 of 3");
	});

	it("does not move the first tab left", () => {
		const props = renderTabs();

		fireEvent.keyDown(screen.getByRole("tab", { name: /zsh — todo-api/ }), {
			key: "ArrowLeft",
			altKey: true,
			shiftKey: true,
		});

		expect(props.onReorder).not.toHaveBeenCalled();
	});

	it("closes a tab with Delete and with the close button", () => {
		const props = renderTabs();

		fireEvent.keyDown(screen.getByRole("tab", { name: /zsh — todo-api/ }), {
			key: "Delete",
		});
		expect(props.onClose).toHaveBeenCalledWith("t1");

		fireEvent.click(screen.getByRole("button", { name: "Close zsh — todo-api" }));
		expect(props.onClose).toHaveBeenLastCalledWith("t1");
	});

	it("shows a dirty tab's dot instead of a close button", () => {
		renderTabs();

		expect(screen.getByRole("img", { name: "Unsaved changes" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Close app.ts" })).toBeNull();
	});

	it("marks an ended terminal for assistive technology", () => {
		renderTabs();

		const ended = screen.getByRole("tab", { name: /zsh — old/ });
		expect(ended.textContent).toContain(", session ended");
		expect(ended.className).toContain("pk-tab--ended");
	});
});

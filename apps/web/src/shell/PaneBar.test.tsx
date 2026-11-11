import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { PaneBar } from "./PaneBar.js";

function renderBar(open: "projects" | "files" | null) {
	const onOpen = vi.fn();
	render(
		<PaneBar
			drawers={{
				open,
				onOpen,
				projectsRef: { current: null },
				filesRef: { current: null },
			}}
		/>,
	);
	return onOpen;
}

test("the drawer buttons are named for what they do, apart from the dialogs they open", () => {
	renderBar(null);
	// A button and the dialog it opens must not share a name (SPEC.md §25.8),
	// while the visible words stay inside the name.
	for (const [name, shown] of [
		["Show projects", "Projects"],
		["Show files", "Files"],
	] as const) {
		const button = screen.getByRole("button", { name });
		expect(button.textContent).toContain(shown);
	}
	expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
});

test("the pane bar has Projects and Files drawer buttons that say whether they are open", () => {
	const onOpen = renderBar("files");
	const projects = screen.getByRole("button", { name: "Show projects" });
	const files = screen.getByRole("button", { name: "Show files" });
	expect(projects.getAttribute("aria-expanded")).toBe("false");
	expect(files.getAttribute("aria-expanded")).toBe("true");
	expect(files.getAttribute("aria-controls")).toBe("files-drawer");
	expect(projects.getAttribute("aria-controls")).toBe("projects-drawer");
	fireEvent.click(projects);
	fireEvent.click(files);
	fireEvent.click(screen.getByRole("button", { name: "Work" }));
	expect(onOpen.mock.calls).toEqual([["projects"], ["files"], [null]]);
});

test("Work is the current pane while no drawer is open", () => {
	renderBar(null);
	expect(
		screen.getByRole("button", { name: "Work" }).getAttribute("aria-current"),
	).toBe("true");
	expect(screen.getByRole("navigation", { name: "Panes" })).toBeTruthy();
});

test("Work is not current while a drawer is open", () => {
	renderBar("projects");
	expect(
		screen.getByRole("button", { name: "Work" }).hasAttribute("aria-current"),
	).toBe(false);
});

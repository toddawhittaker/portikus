import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	ContextMenu,
	ContextMenuTrigger,
	Menu,
	MenuCheckboxItem,
	MenuItem,
	MenuLabel,
	MenuRoot,
	MenuSeparator,
	MenuTrigger,
} from "./menu";

function Fixture({ onSelect }: { onSelect: () => void }) {
	return (
		<MenuRoot>
			<MenuTrigger>Actions</MenuTrigger>
			<Menu label="Project actions">
				<MenuLabel>Project</MenuLabel>
				<MenuItem icon="file" shortcut={["Mod", "R"]} onSelect={onSelect}>
					Rename
				</MenuItem>
				<MenuItem disabled onSelect={onSelect}>
					Initialize Git
				</MenuItem>
				<MenuSeparator />
				<MenuItem danger onSelect={onSelect}>
					Archive…
				</MenuItem>
				<MenuItem
					href="/projects/demo/archive.zip"
					download="demo.zip"
					testId="download-project"
				>
					Download
				</MenuItem>
			</Menu>
		</MenuRoot>
	);
}

describe("Menu", () => {
	it("opens on click and runs an item's onSelect", () => {
		const onSelect = vi.fn();
		render(<Fixture onSelect={onSelect} />);

		fireEvent.pointerDown(screen.getByText("Actions"), { button: 0, ctrlKey: false });
		expect(screen.getByRole("menu")).toBeTruthy();

		fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));
		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	it("opens from the keyboard", () => {
		render(<Fixture onSelect={vi.fn()} />);

		fireEvent.keyDown(screen.getByText("Actions"), { key: "Enter" });
		expect(screen.getByRole("menu")).toBeTruthy();
	});

	it("does not select a disabled item", () => {
		const onSelect = vi.fn();
		render(<Fixture onSelect={onSelect} />);
		fireEvent.pointerDown(screen.getByText("Actions"), { button: 0 });

		const disabled = screen.getByRole("menuitem", { name: "Initialize Git" });
		expect(disabled.getAttribute("data-disabled")).not.toBeNull();
		fireEvent.click(disabled);
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("renders a download item as a link that saves under a name", () => {
		render(<Fixture onSelect={vi.fn()} />);
		fireEvent.pointerDown(screen.getByText("Actions"), { button: 0 });

		const link = screen.getByTestId("download-project");
		expect(link.tagName).toBe("A");
		expect(link.getAttribute("href")).toBe("/projects/demo/archive.zip");
		expect(link.getAttribute("download")).toBe("demo.zip");
	});

	it("marks a destructive item", () => {
		render(<Fixture onSelect={vi.fn()} />);
		fireEvent.pointerDown(screen.getByText("Actions"), { button: 0 });

		expect(screen.getByRole("menuitem", { name: "Archive…" }).className).toContain(
			"pk-menu-item--danger",
		);
	});

	/** Issue #361: a toggle inside a menu is a menu item, so arrows and Enter reach it. */
	it("offers a checkbox item that toggles from the keyboard", () => {
		const onCheckedChange = vi.fn();
		render(
			<MenuRoot>
				<MenuTrigger>Actions</MenuTrigger>
				<Menu label="View">
					<MenuCheckboxItem
						checked={false}
						onCheckedChange={onCheckedChange}
						testId="show-hidden"
					>
						Show hidden files
					</MenuCheckboxItem>
				</Menu>
			</MenuRoot>,
		);
		fireEvent.keyDown(screen.getByText("Actions"), { key: "Enter" });

		const item = screen.getByRole("menuitemcheckbox", { name: "Show hidden files" });
		expect(item.getAttribute("aria-checked")).toBe("false");
		expect(item.getAttribute("data-testid")).toBe("show-hidden");
		fireEvent.keyDown(item, { key: "Enter" });
		expect(onCheckedChange).toHaveBeenCalledWith(true);
	});

	it("shows a checked checkbox item as checked in the context menu family", () => {
		render(
			<ContextMenu>
				<ContextMenuTrigger>Area</ContextMenuTrigger>
				<Menu label="View">
					<MenuCheckboxItem checked onCheckedChange={vi.fn()}>
						Word wrap
					</MenuCheckboxItem>
				</Menu>
			</ContextMenu>,
		);
		fireEvent.contextMenu(screen.getByText("Area"));

		const item = screen.getByRole("menuitemcheckbox", { name: "Word wrap" });
		expect(item.getAttribute("aria-checked")).toBe("true");
	});
});

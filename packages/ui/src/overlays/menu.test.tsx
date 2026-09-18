import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	Menu,
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
});

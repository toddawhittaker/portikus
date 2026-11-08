import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IconButton } from "../primitives/IconButton.js";
import {
	ContextMenu,
	ContextMenuTrigger,
	Menu,
	MenuCheckboxItem,
	MenuItem,
	MenuLabel,
	MenuRadioGroup,
	MenuRadioItem,
	MenuRoot,
	MenuSeparator,
	MenuSub,
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

	it("keeps an unavailable item reachable but does not select it", () => {
		const onSelect = vi.fn();
		render(
			<MenuRoot>
				<MenuTrigger>Actions</MenuTrigger>
				<Menu label="Workspace actions">
					<MenuItem unavailable onSelect={onSelect}>
						Stop
					</MenuItem>
				</Menu>
			</MenuRoot>,
		);
		fireEvent.pointerDown(screen.getByText("Actions"), { button: 0 });

		const item = screen.getByRole("menuitem", { name: "Stop" });
		expect(item.getAttribute("aria-disabled")).toBe("true");
		// Not Radix's disabled, which the arrow keys skip.
		expect(item.hasAttribute("data-disabled")).toBe(false);
		fireEvent.click(item);
		expect(onSelect).not.toHaveBeenCalled();
		expect(screen.getByRole("menu")).toBeTruthy();
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

	/** A toggle inside a menu is a menu item, so arrows and Enter reach it. */
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

	it("radio items state one choice of several and report the new value", () => {
		const onValueChange = vi.fn();
		render(
			<MenuRoot>
				<MenuTrigger>Actions</MenuTrigger>
				<Menu label="Width">
					<MenuItem>Copy URL</MenuItem>
					<MenuRadioGroup label="Width" value="fit" onValueChange={onValueChange}>
						<MenuRadioItem value="fit" testId="width-fit">
							Fit width
						</MenuRadioItem>
						<MenuRadioItem value="768">768 px wide</MenuRadioItem>
					</MenuRadioGroup>
				</Menu>
			</MenuRoot>,
		);
		fireEvent.keyDown(screen.getByText("Actions"), { key: "Enter" });

		expect(screen.getByRole("group", { name: "Width" })).toBeTruthy();
		const fit = screen.getByRole("menuitemradio", { name: "Fit width" });
		const narrow = screen.getByRole("menuitemradio", { name: "768 px wide" });
		expect(fit.getAttribute("aria-checked")).toBe("true");
		expect(fit.getAttribute("data-testid")).toBe("width-fit");
		expect(narrow.getAttribute("aria-checked")).toBe("false");
		// Only the chosen item shows the tick; both keep its gutter.
		expect(fit.querySelector(".pk-menu-check svg")).not.toBeNull();
		expect(narrow.querySelector(".pk-menu-check svg")).toBeNull();
		fireEvent.keyDown(narrow, { key: "Enter" });
		expect(onValueChange).toHaveBeenCalledWith("768");
	});

	it("a radio item's line under its label describes it without joining its name", () => {
		render(
			<MenuRoot>
				<MenuTrigger>Model</MenuTrigger>
				<Menu label="Model" align="start">
					<MenuRadioGroup label="Model" value="opus" onValueChange={vi.fn()}>
						<MenuRadioItem value="opus" description="For hard problems.">
							Opus
						</MenuRadioItem>
						<MenuRadioItem value="haiku">Haiku</MenuRadioItem>
					</MenuRadioGroup>
				</Menu>
			</MenuRoot>,
		);
		fireEvent.keyDown(screen.getByText("Model"), { key: "Enter" });

		const opus = screen.getByRole("menuitemradio", { name: "Opus" });
		expect(opus.className).toContain("pk-menu-item--described");
		const described = document.getElementById(
			opus.getAttribute("aria-describedby") ?? "",
		);
		expect(described?.textContent).toBe("For hard problems.");
		const haiku = screen.getByRole("menuitemradio", { name: "Haiku" });
		expect(haiku.hasAttribute("aria-describedby")).toBe(false);
		expect(haiku.className).not.toContain("pk-menu-item--described");
	});

	it("an unavailable radio item stays reachable, unchecked, and changes nothing", () => {
		const onValueChange = vi.fn();
		render(
			<MenuRoot>
				<MenuTrigger>Agent</MenuTrigger>
				<Menu label="Agent">
					<MenuRadioGroup label="Agent" value="claude" onValueChange={onValueChange}>
						<MenuRadioItem value="claude">Claude Code</MenuRadioItem>
						<MenuRadioItem value="codex" unavailable description="Coming soon.">
							Codex
						</MenuRadioItem>
					</MenuRadioGroup>
				</Menu>
			</MenuRoot>,
		);
		fireEvent.keyDown(screen.getByText("Agent"), { key: "Enter" });

		const codex = screen.getByRole("menuitemradio", { name: "Codex" });
		expect(codex.getAttribute("aria-disabled")).toBe("true");
		expect(codex.getAttribute("aria-checked")).toBe("false");
		// Not Radix's disabled, which the arrow keys skip.
		expect(codex.hasAttribute("data-disabled")).toBe(false);
		fireEvent.keyDown(codex, { key: "Enter" });
		fireEvent.click(codex);
		expect(onValueChange).not.toHaveBeenCalled();
		expect(screen.getByRole("menu")).toBeTruthy();
	});

	it("radio items work in the context menu family", () => {
		render(
			<ContextMenu>
				<ContextMenuTrigger>Area</ContextMenuTrigger>
				<Menu label="Width">
					<MenuRadioGroup label="Width" value="768" onValueChange={vi.fn()}>
						<MenuRadioItem value="fit">Fit width</MenuRadioItem>
						<MenuRadioItem value="768">768 px wide</MenuRadioItem>
					</MenuRadioGroup>
				</Menu>
			</ContextMenu>,
		);
		fireEvent.contextMenu(screen.getByText("Area"));
		expect(
			screen
				.getByRole("menuitemradio", { name: "768 px wide" })
				.getAttribute("aria-checked"),
		).toBe("true");
	});

	// The trigger takes focus back, but its tooltip stays shut.
	it("returns focus to an icon trigger without opening its tooltip", async () => {
		render(
			<MenuRoot>
				<MenuTrigger asChild>
					<IconButton icon="more" label="Project actions" />
				</MenuTrigger>
				<Menu label="Project actions">
					<MenuItem>Rename</MenuItem>
				</Menu>
			</MenuRoot>,
		);
		const trigger = screen.getByRole("button", { name: "Project actions" });
		fireEvent.keyDown(trigger, { key: "Enter" });
		fireEvent.keyDown(await screen.findByRole("menu"), { key: "Escape" });
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		expect(screen.queryByRole("menu")).toBeNull();
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	it("marks the check gutter so plain items can line up with it", () => {
		render(
			<MenuRoot>
				<MenuTrigger>Actions</MenuTrigger>
				<Menu label="View">
					<MenuCheckboxItem checked={false} onCheckedChange={vi.fn()}>
						Light terminal
					</MenuCheckboxItem>
					<MenuItem>Rename</MenuItem>
				</Menu>
			</MenuRoot>,
		);
		fireEvent.keyDown(screen.getByText("Actions"), { key: "Enter" });
		const check = screen.getByRole("menuitemcheckbox", { name: "Light terminal" });
		expect(check.firstElementChild?.classList.contains("pk-menu-check")).toBe(true);
	});

	it("opens a submenu named by its item, from the keyboard", () => {
		const onSelect = vi.fn();
		render(
			<MenuRoot>
				<MenuTrigger>Actions</MenuTrigger>
				<Menu label="Pane">
					<MenuSub label="Move into">
						<MenuItem onSelect={onSelect}>bash</MenuItem>
					</MenuSub>
				</Menu>
			</MenuRoot>,
		);
		fireEvent.keyDown(screen.getByText("Actions"), { key: "Enter" });
		const item = screen.getByRole("menuitem", { name: "Move into" });
		expect(item.getAttribute("aria-haspopup")).toBe("menu");

		fireEvent.keyDown(item, { key: "ArrowRight" });
		expect(screen.getByRole("menu", { name: "Move into" })).toBeTruthy();
		fireEvent.click(screen.getByRole("menuitem", { name: "bash" }));
		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	it("Escape in a submenu returns to its parent menu", () => {
		render(
			<MenuRoot>
				<MenuTrigger>Actions</MenuTrigger>
				<Menu label="Pane">
					<MenuSub label="Split right">
						<MenuItem>Terminal</MenuItem>
					</MenuSub>
				</Menu>
			</MenuRoot>,
		);
		fireEvent.keyDown(screen.getByText("Actions"), { key: "Enter" });
		const item = screen.getByRole("menuitem", { name: "Split right" });
		fireEvent.keyDown(item, { key: "Enter" });
		const sub = screen.getByRole("menu", { name: "Split right" });

		fireEvent.keyDown(sub, { key: "Escape" });
		expect(screen.queryByRole("menu", { name: "Split right" })).toBeNull();
		expect(screen.getAllByRole("menu")).toHaveLength(1);
		expect(document.activeElement).toBe(item);
	});

	it("a disabled submenu item does not open", () => {
		render(
			<MenuRoot>
				<MenuTrigger>Actions</MenuTrigger>
				<Menu label="Pane">
					<MenuSub label="Move into" disabled>
						<MenuItem>bash</MenuItem>
					</MenuSub>
				</Menu>
			</MenuRoot>,
		);
		fireEvent.keyDown(screen.getByText("Actions"), { key: "Enter" });
		const item = screen.getByRole("menuitem", { name: "Move into" });
		expect(item.getAttribute("aria-disabled")).toBe("true");

		fireEvent.keyDown(item, { key: "ArrowRight" });
		expect(screen.queryByRole("menu", { name: "Move into" })).toBeNull();
	});
});

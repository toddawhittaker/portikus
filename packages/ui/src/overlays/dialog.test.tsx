import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";
import { Dialog, DialogRoot, DialogTrigger } from "./dialog";

function Fixture() {
	return (
		<DialogRoot>
			<DialogTrigger>New project</DialogTrigger>
			<Dialog
				id="d"
				title="New project"
				description="Projects live in ~/projects."
				footer={<button type="button">Create</button>}
			>
				<input aria-label="Name" />
			</Dialog>
		</DialogRoot>
	);
}

describe("Dialog", () => {
	it("opens with its title, description and body", () => {
		render(<Fixture />);
		fireEvent.click(screen.getByText("New project"));

		const dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain("Projects live in ~/projects.");
		expect(screen.getByLabelText("Name")).toBeTruthy();
	});

	it("closes on Escape and returns focus to the trigger", async () => {
		render(<Fixture />);
		const trigger = screen.getByText("New project");
		fireEvent.click(trigger);
		expect(screen.getByRole("dialog")).toBeTruthy();

		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

		expect(screen.queryByRole("dialog")).toBeNull();
		// Radix restores focus after the close animation frame.
		await waitFor(() => expect(document.activeElement).toBe(trigger));
	});

	it("closes from the close button", () => {
		render(<Fixture />);
		fireEvent.click(screen.getByText("New project"));

		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("returns focus to the button that opened it from state, with no trigger (#358)", async () => {
		function StateFixture() {
			const [open, setOpen] = React.useState(false);
			return (
				<>
					<button type="button" onClick={() => setOpen(true)}>
						Rename
					</button>
					<DialogRoot open={open} onOpenChange={setOpen}>
						<Dialog title="Rename" />
					</DialogRoot>
				</>
			);
		}
		render(<StateFixture />);
		const opener = screen.getByText("Rename", { selector: "button" });
		opener.focus();
		fireEvent.click(opener);

		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

		await waitFor(() => expect(document.activeElement).toBe(opener));
	});

	it("falls back to the menu trigger when the opening menu item is gone (#358)", async () => {
		function MenuFixture() {
			const [menuOpen, setMenuOpen] = React.useState(true);
			const [open, setOpen] = React.useState(false);
			return (
				<>
					<button type="button" id="menu-trigger">
						Project actions
					</button>
					{menuOpen ? (
						<div role="menu" aria-labelledby="menu-trigger">
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									setOpen(true);
									setMenuOpen(false);
								}}
							>
								Rename…
							</button>
						</div>
					) : null}
					<DialogRoot open={open} onOpenChange={setOpen}>
						<Dialog title="Rename project" />
					</DialogRoot>
				</>
			);
		}
		render(<MenuFixture />);
		const item = screen.getByRole("menuitem");
		item.focus();
		fireEvent.click(item);
		expect(item.isConnected).toBe(false);

		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByText("Project actions")),
		);
	});

	it("falls back to what had focus before an unlabelled menu opened (#358)", async () => {
		// A right-click menu has no trigger button to go back to.
		function ContextFixture() {
			const [menuOpen, setMenuOpen] = React.useState(false);
			const [open, setOpen] = React.useState(false);
			return (
				<>
					<button type="button" onClick={() => setMenuOpen(true)}>
						README.md
					</button>
					{menuOpen ? (
						<div role="menu" aria-label="Actions for README.md">
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									setOpen(true);
									setMenuOpen(false);
								}}
							>
								Delete…
							</button>
						</div>
					) : null}
					<DialogRoot open={open} onOpenChange={setOpen}>
						<Dialog title="Delete README.md" />
					</DialogRoot>
				</>
			);
		}
		render(<ContextFixture />);
		const row = screen.getByText("README.md");
		row.focus();
		fireEvent.click(row);
		const item = screen.getByRole("menuitem");
		item.focus();
		fireEvent.click(item);

		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

		await waitFor(() => expect(document.activeElement).toBe(row));
	});
});

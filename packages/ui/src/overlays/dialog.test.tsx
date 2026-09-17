import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	ConfirmDialog,
	ConfirmDialogRoot,
	ConfirmDialogTrigger,
} from "./confirm-dialog";

function Fixture(props: {
	onConfirm?: () => void;
	pending?: boolean;
	confirmText?: string;
}) {
	return (
		<ConfirmDialogRoot defaultOpen>
			<ConfirmDialogTrigger>Archive</ConfirmDialogTrigger>
			<ConfirmDialog
				title="Archive todo-api?"
				description="You can bring it back from Archived projects."
				lost={["The project in the list"]}
				survives={["The files on disk"]}
				confirmLabel="Archive project"
				onConfirm={props.onConfirm}
				pending={props.pending}
				confirmText={props.confirmText}
			/>
		</ConfirmDialogRoot>
	);
}

describe("ConfirmDialog", () => {
	it("shows what is lost and what survives, and confirms", () => {
		const onConfirm = vi.fn();
		render(<Fixture onConfirm={onConfirm} />);

		const dialog = screen.getByRole("alertdialog");
		expect(dialog.textContent).toContain("Will be removed");
		expect(dialog.textContent).toContain("The files on disk");

		fireEvent.click(screen.getByRole("button", { name: "Archive project" }));
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it("disables the confirm button while pending", () => {
		render(<Fixture pending />);

		const confirm = screen.getByRole("button", { name: "Archive project…" });
		expect(confirm.hasAttribute("disabled")).toBe(true);
		expect(confirm.getAttribute("aria-busy")).toBe("true");
	});

	it("keeps the confirm button disabled until the text matches", () => {
		const onConfirm = vi.fn();
		render(<Fixture onConfirm={onConfirm} confirmText="todo-api" />);

		expect(
			screen.getByRole("button", { name: "Archive project" }).hasAttribute("disabled"),
		).toBe(true);

		fireEvent.change(screen.getByLabelText(/to confirm/), {
			target: { value: "todo-api" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Archive project" }));
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});
});

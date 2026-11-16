import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ApprovalCard, type ApprovalCardData } from "./ApprovalCard";

afterEach(cleanup);

const CHANGE: ApprovalCardData = {
	type: "permission",
	id: "call-1",
	toolName: "users_disable",
	title: "Disable a user's account",
	input: { userId: "fake-user", reason: "left the course" },
	risk: "change",
	options: [
		{ id: "approve", label: "Allow", decision: "allowed" },
		{ id: "always", label: "Always allow", decision: "allowedAlways" },
		{ id: "reject", label: "Deny", decision: "denied" },
	],
};

const DESTRUCTIVE: ApprovalCardData = {
	...CHANGE,
	id: "call-2",
	toolName: "users_delete",
	title: "Delete a user",
	risk: "destructive",
	confirmText: "users_delete",
};

test("a change card is drawn from the card's fields: title, risk, operation and an inputs table", () => {
	render(<ApprovalCard card={CHANGE} onAnswer={() => true} />);
	expect(
		screen.getByRole("heading", { name: "Disable a user's account" }),
	).toBeTruthy();
	expect(screen.getByTestId("approval-risk").textContent).toBe("Change");
	expect(screen.getByText("users_disable")).toBeTruthy();
	const table = screen.getByRole("table", { name: "Inputs" });
	const rows = within(table).getAllByRole("row").slice(1);
	expect(rows.map((row) => row.textContent)).toEqual([
		"userIdfake-user",
		"reasonleft the course",
	]);
	// Approve and Deny only; a lasting option is never offered.
	expect(screen.queryByText("Always allow")).toBeNull();
	expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
		"Approve",
		"Deny",
	]);
});

test("Approve answers with the option that allows, with no confirmation", () => {
	const onAnswer = vi.fn(() => true);
	render(<ApprovalCard card={CHANGE} onAnswer={onAnswer} autoFocus />);
	const approve = screen.getByRole("button", { name: "Approve" });
	expect(document.activeElement).toBe(approve);
	fireEvent.click(approve);
	expect(onAnswer).toHaveBeenCalledWith("approve", undefined);
	// One answer per card.
	fireEvent.click(screen.getByRole("button", { name: "Deny" }));
	expect(onAnswer).toHaveBeenCalledTimes(1);
});

test("Deny answers with the option that denies", () => {
	const onAnswer = vi.fn(() => true);
	render(<ApprovalCard card={CHANGE} onAnswer={onAnswer} />);
	fireEvent.click(screen.getByRole("button", { name: "Deny" }));
	expect(onAnswer).toHaveBeenCalledWith("reject", undefined);
});

test("a destructive card stays locked until its confirmation text is typed exactly", () => {
	const onAnswer = vi.fn(() => true);
	render(<ApprovalCard card={DESTRUCTIVE} onAnswer={onAnswer} autoFocus />);
	expect(screen.getByTestId("approval-risk").textContent).toBe("Destructive");
	const box = screen.getByLabelText("Type users_delete to approve");
	// The typed box is the first thing to reach.
	expect(document.activeElement).toBe(box);
	const approve = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
	expect(approve.disabled).toBe(true);
	for (const wrong of ["users_delet", "Users_delete", "users_delete "]) {
		fireEvent.change(box, { target: { value: wrong } });
		expect(approve.disabled).toBe(true);
	}
	// Enter in the box cannot get past the lock either.
	fireEvent.submit(box.closest("form") as HTMLFormElement);
	expect(onAnswer).not.toHaveBeenCalled();

	fireEvent.change(box, { target: { value: "users_delete" } });
	expect(approve.disabled).toBe(false);
	fireEvent.click(approve);
	expect(onAnswer).toHaveBeenCalledWith("approve", "users_delete");
});

test("a destructive card can be denied without typing", () => {
	const onAnswer = vi.fn(() => true);
	render(<ApprovalCard card={DESTRUCTIVE} onAnswer={onAnswer} />);
	fireEvent.click(screen.getByRole("button", { name: "Deny" }));
	expect(onAnswer).toHaveBeenCalledWith("reject", undefined);
});

test("a destructive card without confirmation text can never be approved", () => {
	const { confirmText: _, ...card } = DESTRUCTIVE;
	render(<ApprovalCard card={card} onAnswer={() => true} />);
	expect(
		(screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled,
	).toBe(true);
});

test("an answer that could not be sent says so and leaves the buttons live", () => {
	const onAnswer = vi.fn(() => false);
	render(<ApprovalCard card={CHANGE} onAnswer={onAnswer} />);
	fireEvent.click(screen.getByRole("button", { name: "Approve" }));
	expect(screen.getByRole("alert").textContent).toMatch(/not connected/);
	fireEvent.click(screen.getByRole("button", { name: "Approve" }));
	expect(onAnswer).toHaveBeenCalledTimes(2);
});

test("a resolved card shows its outcome instead of the buttons", () => {
	const { rerender } = render(
		<ApprovalCard card={DESTRUCTIVE} decision="denied" onAnswer={() => true} />,
	);
	expect(screen.getByTestId("approval-outcome").textContent).toBe("Denied");
	expect(screen.queryByRole("button")).toBeNull();
	expect(screen.queryByRole("textbox")).toBeNull();
	rerender(<ApprovalCard card={CHANGE} decision="allowed" onAnswer={() => true} />);
	expect(screen.getByTestId("approval-outcome").textContent).toBe("Approved");
});

test("an operation with no description is titled by its name, and empty inputs say so", () => {
	render(
		<ApprovalCard card={{ ...CHANGE, title: "  ", input: {} }} onAnswer={() => true} />,
	);
	expect(screen.getByRole("heading", { name: "users_disable" })).toBeTruthy();
	expect(screen.getByText("No inputs")).toBeTruthy();
});

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
	// A new card is read from its title first, not from a button.
	expect(document.activeElement).toBe(
		screen.getByRole("heading", { name: "Disable a user's account" }),
	);
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
	expect(document.activeElement).toBe(
		screen.getByRole("heading", { name: "Delete a user" }),
	);
	const approve = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
	// Locked but focusable, and it says what unlocks it.
	expect(approve.disabled).toBe(false);
	expect(approve.getAttribute("aria-disabled")).toBe("true");
	expect(
		document.getElementById(approve.getAttribute("aria-describedby") ?? "")
			?.textContent,
	).toBe("Type users_delete to approve");
	for (const wrong of ["users_delet", "Users_delete", "users_delete "]) {
		fireEvent.change(box, { target: { value: wrong } });
		expect(approve.getAttribute("aria-disabled")).toBe("true");
		fireEvent.click(approve);
	}
	// Enter in the box cannot get past the lock either.
	fireEvent.submit(box.closest("form") as HTMLFormElement);
	expect(onAnswer).not.toHaveBeenCalled();

	fireEvent.change(box, { target: { value: "users_delete" } });
	expect(approve.hasAttribute("aria-disabled")).toBe(false);
	expect(approve.hasAttribute("aria-describedby")).toBe(false);
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
	const onAnswer = vi.fn(() => true);
	render(<ApprovalCard card={card} onAnswer={onAnswer} />);
	const approve = screen.getByRole("button", { name: "Approve" });
	expect(approve.getAttribute("aria-disabled")).toBe("true");
	fireEvent.click(approve);
	expect(onAnswer).not.toHaveBeenCalled();
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

const BATCH: ApprovalCardData = {
	type: "permission",
	id: "call-3",
	toolName: "run_batch",
	title: "Invites someone by email to join the site with a role",
	input: {
		operation: "invitations.create",
		rows: [
			{ body: { email: "a@example.edu", name: "Ann", role: "student" } },
			{ body: { email: "b@example.edu", name: "Ben", role: "student" } },
			{ body: { email: "c@example.edu", role: "student" } },
		],
	},
	risk: "change",
	confirmText: "3",
	options: [
		{ id: "approve", label: "Approve", decision: "allowed" },
		{ id: "deny", label: "Deny", decision: "denied" },
	],
};

test("a batch card draws one numbered table row per input, under header cells and a caption", () => {
	render(<ApprovalCard card={BATCH} onAnswer={() => true} />);
	const table = screen.getByRole("table", {
		name: "3 rows for invitations.create",
	});
	expect(
		within(table)
			.getAllByRole("columnheader")
			.map((cell) => cell.textContent),
	).toEqual(["Row", "email", "name", "role"]);
	const rows = within(table).getAllByRole("row").slice(1);
	expect(rows.map((row) => row.textContent)).toEqual([
		"1a@example.eduAnnstudent",
		"2b@example.eduBenstudent",
		"3c@example.edustudent",
	]);
	expect(within(rows[0] as HTMLElement).getByRole("rowheader").textContent).toBe("1");
	expect(screen.getByText("invitations.create")).toBeTruthy();
	expect(screen.getByText(/3 rows, run one at a time/)).toBeTruthy();
	// The scrolling region is reachable by keyboard.
	expect(
		screen.getByRole("region", { name: "Rows for invitations.create" }).tabIndex,
	).toBe(0);
});

test("a change batch stays locked until its row count is typed", () => {
	const onAnswer = vi.fn(() => true);
	render(<ApprovalCard card={BATCH} onAnswer={onAnswer} autoFocus />);
	expect(screen.getByTestId("approval-risk").textContent).toBe("Change");
	const box = screen.getByLabelText("Type 3 to approve");
	const approve = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
	expect(approve.getAttribute("aria-disabled")).toBe("true");
	for (const wrong of ["2", "30", "three", " 3"]) {
		fireEvent.change(box, { target: { value: wrong } });
		fireEvent.click(approve);
	}
	expect(onAnswer).not.toHaveBeenCalled();
	fireEvent.change(box, { target: { value: "3" } });
	expect(approve.hasAttribute("aria-disabled")).toBe(false);
	fireEvent.click(approve);
	expect(onAnswer).toHaveBeenCalledWith("approve", "3");
});

test("a field name used by two parts of the input keeps its part, and a missing field is an empty cell", () => {
	render(
		<ApprovalCard
			card={{
				...BATCH,
				confirmText: "2",
				input: {
					operation: "x.y",
					rows: [
						{ path: { id: "w-1" }, body: { id: "b-1", note: "n1" } },
						{ path: { id: "w-2" }, query: { page: 2 } },
					],
				},
			}}
			onAnswer={() => true}
		/>,
	);
	const table = screen.getByRole("table");
	expect(
		within(table)
			.getAllByRole("columnheader")
			.map((cell) => cell.textContent),
	).toEqual(["Row", "path.id", "body.id", "note", "page"]);
	expect(
		within(table)
			.getAllByRole("row")
			.slice(1)
			.map((row) => row.textContent),
	).toEqual(["1w-1b-1n1", "2w-22"]);
});

test("a destructive batch and a batch whose body is not an object both draw", () => {
	render(
		<ApprovalCard
			card={{
				...BATCH,
				risk: "destructive",
				input: { operation: "egress.add_entry", rows: [{ body: "raw" }] },
				confirmText: "1",
			}}
			onAnswer={() => true}
		/>,
	);
	expect(screen.getByTestId("approval-risk").textContent).toBe("Destructive");
	expect(
		screen.getByRole("table", { name: "1 row for egress.add_entry" }),
	).toBeTruthy();
	expect(screen.getByText("raw")).toBeTruthy();
	expect(screen.getByLabelText("Type 1 to approve")).toBeTruthy();
});

test("a resolved batch shows its outcome and no box", () => {
	render(<ApprovalCard card={BATCH} decision="allowed" onAnswer={() => true} />);
	expect(screen.getByTestId("approval-outcome").textContent).toBe("Approved");
	expect(screen.queryByRole("textbox")).toBeNull();
});

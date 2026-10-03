import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { AdminGroup, AdminSection } from "./AdminSection.js";

test("renders a region named by its h2, with the count, actions and content", () => {
	render(
		<AdminSection
			title="Users"
			count="3 accounts"
			actions={<button type="button">Add</button>}
		>
			<p>Body</p>
		</AdminSection>,
	);

	const region = screen.getByRole("region", { name: "Users" });
	expect(
		within(region).getByRole("heading", { level: 2, name: "Users" }),
	).toBeDefined();
	expect(within(region).getByText("3 accounts")).toBeDefined();
	expect(within(region).getByRole("button", { name: "Add" })).toBeDefined();
	expect(within(region).getByText("Body")).toBeDefined();
});

test("leaves out the count and actions when not given", () => {
	const { container } = render(
		<AdminSection title="Audit">
			<p>Body</p>
		</AdminSection>,
	);

	expect(screen.getByRole("heading", { level: 2, name: "Audit" })).toBeDefined();
	expect(container.querySelectorAll("button")).toHaveLength(0);
	expect(container.querySelector(".ml-auto")).toBeNull();
});

test("puts the intro under the heading, linked to its Help section", () => {
	render(
		<AdminSection
			title="Users"
			intro={{
				id: "admin-users",
				text: "Everyone who has signed in, with their workspace.",
				helpAnchor: "admin-users",
			}}
		>
			<p>Body</p>
		</AdminSection>,
	);

	const intro = screen.getByTestId("intro-admin-users");
	expect(intro.querySelector("summary")?.textContent).toBe("About Users");
	expect(intro.textContent).toContain("Everyone who has signed in");
	expect(intro.querySelector("a")?.getAttribute("href")).toBe("/help#admin-users");
	// The intro sits between the heading row and the tab's content.
	const heading = screen.getByRole("heading", { level: 2, name: "Users" });
	expect(
		heading.compareDocumentPosition(intro) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	expect(
		intro.compareDocumentPosition(screen.getByText("Body")) &
			Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
});

test("AdminGroup shows a description under its heading only when given", () => {
	const { rerender } = render(
		<AdminGroup id="g" title="Schedule" description="When the nightly backup runs.">
			<p>Body</p>
		</AdminGroup>,
	);

	const region = screen.getByRole("region", { name: "Schedule" });
	const description = within(region).getByText("When the nightly backup runs.");
	expect(description.tagName).toBe("P");
	const heading = within(region).getByRole("heading", { level: 3, name: "Schedule" });
	expect(
		heading.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();

	rerender(
		<AdminGroup id="g" title="Schedule">
			<p>Body</p>
		</AdminGroup>,
	);
	expect(
		screen.getByRole("region", { name: "Schedule" }).querySelectorAll("p"),
	).toHaveLength(1);
});

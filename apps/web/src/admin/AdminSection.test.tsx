import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { AdminSection } from "./AdminSection.js";

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

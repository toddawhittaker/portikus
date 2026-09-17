import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button.js";
import { EmptyState } from "./EmptyState.js";

describe("EmptyState", () => {
	it("renders the title as a heading and the body below it", () => {
		render(
			<EmptyState icon="folder" title="No projects yet">
				A project is a folder in your workspace.
			</EmptyState>,
		);
		expect(screen.getByRole("heading", { name: "No projects yet" })).toBeDefined();
		expect(screen.getByText("A project is a folder in your workspace.")).toBeDefined();
	});

	it("renders its actions", () => {
		const onClick = vi.fn();
		render(
			<EmptyState
				title="No projects yet"
				actions={
					<Button variant="primary" iconStart="plus" onClick={onClick}>
						New project
					</Button>
				}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "New project" }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});

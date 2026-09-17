import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IconButton } from "./IconButton.js";

describe("IconButton", () => {
	it("exposes its label to assistive technology", () => {
		render(<IconButton icon="more" label="Project actions" />);
		expect(screen.getByRole("button", { name: "Project actions" })).toBeDefined();
	});

	it("shows the label and shortcut in the tooltip", () => {
		render(
			<IconButton
				icon="plus"
				label="New tab"
				shortcut={["Mod", "Alt", "T"]}
				tooltipOpen={true}
			/>,
		);
		const tooltips = screen.getAllByText("New tab");
		expect(tooltips.length).toBeGreaterThan(0);
		expect(screen.getAllByLabelText("Shortcut: Control Alt T").length).toBeGreaterThan(
			0,
		);
	});

	it("calls onClick", () => {
		const onClick = vi.fn();
		render(<IconButton icon="x" label="Close" onClick={onClick} />);
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});

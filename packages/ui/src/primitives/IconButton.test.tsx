import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IconButton, skipTooltipOnReturnedFocus } from "./IconButton.js";

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

	it("opens its tooltip when focused", async () => {
		render(<IconButton icon="more" label="Project actions" />);
		act(() => screen.getByRole("button", { name: "Project actions" }).focus());
		expect(await screen.findByRole("tooltip")).toBeDefined();
	});

	// Focus handed back by a closing menu must not pop the name up.
	it("keeps its tooltip closed for focus a menu hands back", async () => {
		render(<IconButton icon="more" label="Project actions" />);
		const button = screen.getByRole("button", { name: "Project actions" });
		act(() => {
			skipTooltipOnReturnedFocus();
			button.focus();
		});
		await Promise.resolve();
		expect(document.activeElement).toBe(button);
		expect(screen.queryByRole("tooltip")).toBeNull();
	});
});

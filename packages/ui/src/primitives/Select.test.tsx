import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Select } from "./Select.js";

const OPTIONS = [
	{ value: "3000", label: "3000 · node" },
	{ value: "5173", label: "5173 · vite" },
];

// Radix Select uses browser APIs jsdom does not implement.
beforeAll(() => {
	Element.prototype.scrollIntoView = vi.fn();
	Element.prototype.hasPointerCapture = vi.fn(() => false);
	Element.prototype.setPointerCapture = vi.fn();
	Element.prototype.releasePointerCapture = vi.fn();
});

describe("Select", () => {
	it("renders with its label as the accessible name and shows the placeholder", () => {
		render(<Select id="tpl" label="Template" placeholder="Choose a template…" />);
		expect(screen.getByLabelText("Template")).toBeDefined();
		expect(screen.getByText("Choose a template…")).toBeDefined();
	});

	it("opens the list and reports the chosen value", () => {
		const onValueChange = vi.fn();
		render(
			<Select
				id="port"
				label="Preview port"
				options={OPTIONS}
				onValueChange={onValueChange}
			/>,
		);

		fireEvent.keyDown(screen.getByLabelText("Preview port"), { key: "Enter" });
		const option = screen.getByText("5173 · vite");
		expect(option).toBeDefined();

		fireEvent.click(option);
		expect(onValueChange).toHaveBeenCalledWith("5173");
	});
});

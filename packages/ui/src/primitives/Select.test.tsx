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

	it("puts a help button beside the label, not inside it", () => {
		render(
			<Select
				id="level"
				label="Service log level"
				options={OPTIONS}
				help={<button type="button">About Service log level</button>}
			/>,
		);
		const label = document.getElementById("level-l");
		const help = screen.getByRole("button", { name: "About Service log level" });
		expect(label?.contains(help)).toBe(false);
		expect(label?.parentElement?.contains(help)).toBe(true);
		expect(screen.getByRole("combobox", { name: /Service log level/ })).toBeDefined();
	});
	// Epic 25: a label row with help keeps the plain label's 18px line, so fields
	// with and without help line up in one row; the 24px button overflows it.
	it("keeps the label row as tall as a plain label when it has help", () => {
		render(
			<>
				<Select
					id="a"
					label="With help"
					options={OPTIONS}
					help={<button type="button">About</button>}
				/>
				<Select id="b" label="Without help" options={OPTIONS} />
			</>,
		);
		const withHelp = document.getElementById("a-l");
		const plain = document.getElementById("b-l");
		expect(plain?.className).toContain("leading-[18px]");
		expect(withHelp?.parentElement?.className).toContain("h-[18px]");
		expect(withHelp?.parentElement?.className).toContain("items-center");
	});
});

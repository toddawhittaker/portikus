import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Checkbox } from "./Checkbox.js";

describe("Checkbox", () => {
	it("renders with its label as the accessible name", () => {
		render(<Checkbox label="Show hidden and generated files" />);
		expect(
			screen.getByRole("checkbox", { name: /Show hidden and generated files/ }),
		).toBeDefined();
	});

	it("puts the description under the label, not on the same line", () => {
		render(
			<Checkbox label="Auto-save" description="Write the file a few seconds later." />,
		);
		const description = screen.getByText("Write the file a few seconds later.");
		expect(description.closest(".pk-checkbox-copy")).not.toBeNull();
		expect(description.previousElementSibling?.textContent).toBe("Auto-save");
	});

	it("is named by its label alone and described by its description", () => {
		render(
			<Checkbox label="Auto-save" description="Write the file a few seconds later." />,
		);
		const box = screen.getByRole("checkbox", { name: "Auto-save" });
		const described = (box.getAttribute("aria-describedby") ?? "")
			.split(" ")
			.map((id) => document.getElementById(id)?.textContent)
			.join(" ");
		expect(described).toBe("Write the file a few seconds later.");
		// Both stay inside the label, so a click anywhere on the row ticks the box.
		expect(
			screen.getByText("Write the file a few seconds later.").closest("label"),
		).toBe(box.closest("label"));
	});

	it("has no description to point at when none is given", () => {
		render(<Checkbox label="Show system" />);
		expect(
			screen
				.getByRole("checkbox", { name: "Show system" })
				.hasAttribute("aria-describedby"),
		).toBe(false);
	});

	it("toggles from the keyboard", () => {
		const onChange = vi.fn();
		render(<Checkbox label="Open preview in a new tab" onChange={onChange} />);
		const box = screen.getByRole("checkbox", {
			name: /Open preview in a new tab/,
		}) as HTMLInputElement;

		// A native checkbox is in the tab order and Space activates it, which the
		// browser delivers as a click. jsdom does not synthesise that, so fire it.
		box.focus();
		expect(document.activeElement).toBe(box);
		fireEvent.click(box);

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(box.checked).toBe(true);
	});

	it("sets the indeterminate property and draws a dash", () => {
		const { container, rerender } = render(
			<Checkbox label="Select all" checked={false} indeterminate onChange={() => {}} />,
		);
		const input = screen.getByRole("checkbox", {
			name: "Select all",
		}) as HTMLInputElement;
		expect(input.indeterminate).toBe(true);
		expect(container.querySelector(".pk-check-box svg")).not.toBeNull();
		rerender(<Checkbox label="Select all" checked={false} onChange={() => {}} />);
		expect(input.indeterminate).toBe(false);
		expect(container.querySelector(".pk-check-box svg")).toBeNull();
	});

	it("stays focusable while busy and says it is unavailable", () => {
		render(
			<Checkbox label="GitHub" checked={false} ariaDisabled onChange={() => {}} />,
		);
		const input = screen.getByRole("checkbox", { name: "GitHub" }) as HTMLInputElement;
		expect(input.disabled).toBe(false);
		expect(input.getAttribute("aria-disabled")).toBe("true");
	});
});

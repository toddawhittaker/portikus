import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { TextField, UnitInput } from "./TextField.js";

describe("TextField", () => {
	it("renders with its label as the accessible name", () => {
		render(<TextField id="url" label="Repository URL" />);
		expect(screen.getByLabelText("Repository URL")).toBeDefined();
	});

	it("is controlled by value and onChange", () => {
		const onChange = vi.fn();
		render(
			<TextField id="name" label="Folder name" value="todo-api" onChange={onChange} />,
		);
		const input = screen.getByLabelText("Folder name") as HTMLInputElement;
		expect(input.value).toBe("todo-api");
		fireEvent.change(input, { target: { value: "todo-web" } });
		expect(onChange).toHaveBeenCalledTimes(1);
		// Still the given value: the parent owns it.
		expect((screen.getByLabelText("Folder name") as HTMLInputElement).value).toBe(
			"todo-api",
		);
	});

	it("links its error text and marks the input invalid", () => {
		render(
			<TextField
				id="slug"
				label="Folder name"
				error="No spaces."
				hint="Lowercase letters."
			/>,
		);
		const input = screen.getByLabelText("Folder name");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(input.getAttribute("aria-describedby")).toBe("slug-hint slug-err");
		expect(screen.getByText("No spaces.")).toBeDefined();
	});

	it("links its warning text without marking the input invalid", () => {
		render(
			<TextField
				id="slug"
				label="Folder name"
				warning="A project called todo-api already exists"
				hint="Lowercase letters."
			/>,
		);
		const input = screen.getByLabelText("Folder name");
		expect(input.getAttribute("aria-invalid")).toBeNull();
		expect(input.getAttribute("data-warning")).toBe("true");
		expect(input.getAttribute("aria-describedby")).toBe("slug-hint slug-warn");
		expect(screen.getByText("A project called todo-api already exists")).toBeDefined();
	});

	it("shows the error and drops the warning when both are given", () => {
		render(
			<TextField id="slug" label="Folder name" error="No spaces." warning="Taken." />,
		);
		const input = screen.getByLabelText("Folder name");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(input.getAttribute("data-warning")).toBeNull();
		expect(screen.queryByText("Taken.")).toBeNull();
	});

	it("puts a help button beside the label, not inside it", () => {
		render(
			<TextField
				id="idle"
				label="Idle stop"
				help={<button type="button">About Idle stop</button>}
			/>,
		);
		const input = screen.getByLabelText("Idle stop");
		const label = document.querySelector("label[for=idle]");
		const help = screen.getByRole("button", { name: "About Idle stop" });
		expect(label?.contains(help)).toBe(false);
		expect(label?.parentElement?.contains(help)).toBe(true);
		expect(input.getAttribute("aria-describedby")).toBeNull();
	});
	// A label row with help keeps the plain label's 18px line, so fields
	// with and without help line up in one row; the 24px button overflows it.
	it("keeps the label row as tall as a plain label when it has help", () => {
		render(
			<>
				<TextField
					id="a"
					label="With help"
					help={<button type="button">About</button>}
				/>
				<TextField id="b" label="Without help" />
			</>,
		);
		const withHelp = document.querySelector("label[for=a]");
		const plain = document.querySelector("label[for=b]");
		expect(plain?.className).toContain("leading-[18px]");
		expect(withHelp?.parentElement?.className).toContain("h-[18px]");
		expect(withHelp?.parentElement?.className).toContain("items-center");
	});

	describe("unit", () => {
		it("shows the unit after the box and keeps the label as the name", () => {
			render(<TextField id="grace" label="Disconnect grace" unit="minutes" />);
			const input = screen.getByLabelText("Disconnect grace");
			const unit = screen.getByText("minutes");
			expect(input.getAttribute("inputmode")).toBe("numeric");
			expect(unit.id).toBe("grace-unit");
			// The unit follows the box in the same row.
			expect(input.nextElementSibling).toBe(unit);
		});

		it("puts the unit in the description, before the hint and the error", () => {
			render(
				<TextField
					id="grace"
					label="Disconnect grace"
					unit="minutes"
					hint="Default 10."
					error="Use a whole number."
				/>,
			);
			const input = screen.getByLabelText("Disconnect grace");
			expect(input.getAttribute("aria-describedby")).toBe(
				"grace-unit grace-hint grace-err",
			);
			expect(input.getAttribute("aria-invalid")).toBe("true");
			// Not hidden from assistive technology, so the description is read.
			expect(screen.getByText("minutes").closest("[aria-hidden]")).toBeNull();
		});

		it("leaves a field with no unit as it was", () => {
			render(<TextField id="name" label="Folder name" hint="Hint." />);
			const input = screen.getByLabelText("Folder name");
			expect(input.getAttribute("aria-describedby")).toBe("name-hint");
			expect(input.parentElement?.className).toContain("pk-field");
			expect(input.className).toContain("w-full");
		});
	});
});

describe("UnitInput", () => {
	it("works without a TextField, named by the caller's own label", () => {
		render(
			<>
				<label htmlFor="idle">Idle stop</label>
				<UnitInput id="idle" unit="minutes" hint="Default 60." defaultValue="45" />
				<p id="idle-hint">Default 60.</p>
			</>,
		);
		const input = screen.getByLabelText("Idle stop") as HTMLInputElement;
		expect(input.value).toBe("45");
		expect(input.getAttribute("aria-describedby")).toBe("idle-unit idle-hint");
		expect(document.getElementById("idle-unit")?.textContent).toBe("minutes");
	});

	it("is a narrow box a parent can widen, and its unit does not shrink", () => {
		render(<UnitInput id="mem" unit="MiB" aria-label="Memory" />);
		const input = screen.getByLabelText("Memory");
		expect(input.className).toContain("w-[5.5rem]");
		expect(input.className).not.toContain("w-full");
		expect(screen.getByText("MiB").className).toContain("shrink-0");
	});

	it("forwards a ref and typing to the input", () => {
		const ref = createRef<HTMLInputElement>();
		const onChange = vi.fn();
		render(
			<UnitInput id="n" unit="%" aria-label="Share" ref={ref} onChange={onChange} />,
		);
		fireEvent.change(screen.getByLabelText("Share"), { target: { value: "25" } });
		expect(ref.current).toBe(screen.getByLabelText("Share"));
		expect(onChange).toHaveBeenCalledTimes(1);
	});
});

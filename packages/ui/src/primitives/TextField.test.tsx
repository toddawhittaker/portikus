import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TextField } from "./TextField.js";

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
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button.js";

describe("Button", () => {
	it("renders with its label as the accessible name", () => {
		render(<Button variant="primary">Start workspace</Button>);
		expect(screen.getByRole("button", { name: "Start workspace" })).toBeDefined();
	});

	it("calls onClick, and does not when disabled", () => {
		const onClick = vi.fn();
		const { rerender } = render(<Button onClick={onClick}>View details</Button>);
		fireEvent.click(screen.getByRole("button", { name: "View details" }));
		expect(onClick).toHaveBeenCalledTimes(1);

		rerender(
			<Button onClick={onClick} disabled={true}>
				View details
			</Button>,
		);
		fireEvent.click(screen.getByRole("button", { name: "View details" }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("keeps the label and marks itself busy while loading", () => {
		render(<Button loading={true}>Starting…</Button>);
		expect(screen.getByRole("button").getAttribute("aria-busy")).toBe("true");
	});

	it("ignores clicks while loading", () => {
		const onClick = vi.fn();
		render(
			<Button loading onClick={onClick}>
				Link accounts
			</Button>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Link accounts" }));
		expect(onClick).not.toHaveBeenCalled();
	});
});

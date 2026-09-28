import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Toggletip } from "./toggletip";

function Fixture() {
	return (
		<>
			<Toggletip label="Idle stop">
				A running workspace with no input for this long is stopped.
			</Toggletip>
			<button type="button">Save</button>
		</>
	);
}

describe("Toggletip", () => {
	it("is a native button named after its subject", () => {
		render(<Fixture />);
		const button = screen.getByRole("button", { name: "About Idle stop" });
		// A native button, so Enter and Space activate it like a click.
		expect(button.tagName).toBe("BUTTON");
		expect(button.getAttribute("type")).toBe("button");
		expect(button.getAttribute("aria-expanded")).toBe("false");
	});

	it("does not open on hover or focus", () => {
		render(<Fixture />);
		const button = screen.getByRole("button", { name: "About Idle stop" });
		fireEvent.pointerEnter(button);
		fireEvent.mouseEnter(button);
		fireEvent.focus(button);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("opens on click as a named dialog and moves focus into it", async () => {
		render(<Fixture />);
		const button = screen.getByRole("button", { name: "About Idle stop" });
		fireEvent.click(button);
		const tip = screen.getByRole("dialog", { name: "Idle stop" });
		expect(tip.textContent).toContain("no input for this long");
		expect(button.getAttribute("aria-expanded")).toBe("true");
		await waitFor(() => expect(tip.contains(document.activeElement)).toBe(true));
	});

	it("closes on Escape and returns focus to its button", async () => {
		render(<Fixture />);
		const button = screen.getByRole("button", { name: "About Idle stop" });
		fireEvent.click(button);
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
		await waitFor(() => expect(document.activeElement).toBe(button));
	});

	it("closes when clicked again", () => {
		render(<Fixture />);
		const button = screen.getByRole("button", { name: "About Idle stop" });
		fireEvent.click(button);
		fireEvent.click(button);
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});

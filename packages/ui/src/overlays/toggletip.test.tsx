import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Toggletip } from "./toggletip";

const nextTick = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});

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

	it("opens on click as a named panel, keeps focus on its button and announces the text", async () => {
		render(<Fixture />);
		const button = screen.getByRole("button", { name: "About Idle stop" });
		const status = button.nextElementSibling as HTMLElement;
		expect(status.getAttribute("aria-live")).toBe("polite");
		// The live region exists before it fills, so the change is announced.
		expect(status.textContent).toBe("");
		button.focus();
		fireEvent.click(button);
		const tip = screen.getByRole("dialog", { name: "Idle stop" });
		expect(tip.textContent).toContain("no input for this long");
		expect(status.textContent).toContain("no input for this long");
		expect(button.getAttribute("aria-expanded")).toBe("true");
		await nextTick();
		expect(document.activeElement).toBe(button);
	});

	it("closes on Escape and keeps focus on its button", async () => {
		render(<Fixture />);
		const button = screen.getByRole("button", { name: "About Idle stop" });
		button.focus();
		fireEvent.click(button);
		fireEvent.keyDown(button, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(button.nextElementSibling?.textContent).toBe("");
		await waitFor(() => expect(document.activeElement).toBe(button));
	});

	it("closes when focus moves on to the next control", async () => {
		render(<Fixture />);
		const button = screen.getByRole("button", { name: "About Idle stop" });
		button.focus();
		fireEvent.click(button);
		// Radix listens for outside focus from the next tick.
		await nextTick();
		const save = screen.getByRole("button", { name: "Save" });
		await act(async () => save.focus());
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(save);
	});

	it("closes when clicked again", () => {
		render(<Fixture />);
		const button = screen.getByRole("button", { name: "About Idle stop" });
		fireEvent.click(button);
		fireEvent.click(button);
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});

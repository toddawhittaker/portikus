import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dialog, DialogRoot } from "./dialog";
import { Toggletip } from "./toggletip";

const TEXT = "A running workspace with no input for this long is stopped.";

const nextTick = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});

function Fixture() {
	return (
		<>
			<Toggletip label="Idle stop">{TEXT}</Toggletip>
			<button type="button">Save</button>
		</>
	);
}

const tip = () => document.querySelector<HTMLElement>(".pk-toggletip-content");
const liveRegion = () => document.querySelector<HTMLElement>("[aria-live='polite']");

describe("Toggletip", () => {
	it("is a native button named after its subject, with no popup claim", () => {
		render(<Fixture />);
		const button = screen.getByRole("button", { name: "About Idle stop" });
		// A native button, so Enter and Space activate it like a click.
		expect(button.tagName).toBe("BUTTON");
		expect(button.getAttribute("type")).toBe("button");
		expect(button.getAttribute("aria-expanded")).toBe("false");
		// Focus never enters the tip, so the button must not promise a dialog.
		expect(button.hasAttribute("aria-haspopup")).toBe(false);
	});

	it("does not open on hover or focus", () => {
		render(<Fixture />);
		const button = screen.getByRole("button", { name: "About Idle stop" });
		fireEvent.pointerEnter(button);
		fireEvent.mouseEnter(button);
		fireEvent.focus(button);
		expect(tip()).toBeNull();
	});

	it("opens on click, keeps focus on its button and announces the text", async () => {
		render(<Fixture />);
		const button = screen.getByRole("button", { name: "About Idle stop" });
		const status = liveRegion();
		// The live region exists before it fills, so the change is announced.
		expect(status?.textContent).toBe("");
		button.focus();
		fireEvent.click(button);
		expect(tip()?.textContent).toBe(TEXT);
		expect(status?.textContent).toBe(TEXT);
		expect(button.getAttribute("aria-expanded")).toBe("true");
		await nextTick();
		expect(document.activeElement).toBe(button);
	});

	it("hides the visible tip from assistive technology", () => {
		render(<Fixture />);
		fireEvent.click(screen.getByRole("button", { name: "About Idle stop" }));
		expect(tip()?.getAttribute("aria-hidden")).toBe("true");
		// Browse mode finds no empty dialog.
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
	});

	it("keeps the tip text out of a table header's name while open", () => {
		render(
			<table>
				<thead>
					<tr>
						<th>
							Idle stop <Toggletip label="Idle stop">{TEXT}</Toggletip>
						</th>
					</tr>
				</thead>
			</table>,
		);
		fireEvent.click(screen.getByRole("button", { name: "About Idle stop" }));
		expect(liveRegion()?.textContent).toBe(TEXT);
		const header = screen.getByRole("columnheader", {
			name: (name) => name.startsWith("Idle stop") && !name.includes("no input"),
		});
		expect(header.textContent).not.toContain(TEXT);
	});

	it("announces from inside a modal dialog, where the rest of the page is hidden", async () => {
		render(
			<DialogRoot open>
				<Dialog title="Settings">
					<Toggletip label="Idle stop">{TEXT}</Toggletip>
				</Dialog>
			</DialogRoot>,
		);
		const dialog = await screen.findByRole("dialog", { name: "Settings" });
		fireEvent.click(screen.getByRole("button", { name: "About Idle stop" }));
		const status = liveRegion();
		expect(status?.textContent).toBe(TEXT);
		expect(dialog.contains(status)).toBe(true);
	});

	it("closes on Escape and keeps focus on its button", async () => {
		render(<Fixture />);
		const button = screen.getByRole("button", { name: "About Idle stop" });
		button.focus();
		fireEvent.click(button);
		fireEvent.keyDown(button, { key: "Escape" });
		expect(tip()).toBeNull();
		expect(liveRegion()?.textContent).toBe("");
		await waitFor(() => expect(document.activeElement).toBe(button));
	});

	it("does not pull focus back after Escape once focus has moved on", async () => {
		render(<Fixture />);
		const button = screen.getByRole("button", { name: "About Idle stop" });
		button.focus();
		fireEvent.click(button);
		await nextTick();
		fireEvent.keyDown(button, { key: "Escape" });
		const save = screen.getByRole("button", { name: "Save" });
		save.focus();
		await nextTick();
		expect(document.activeElement).toBe(save);
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
		expect(tip()).toBeNull();
		expect(document.activeElement).toBe(save);
	});

	it("closes when clicked again", () => {
		render(<Fixture />);
		const button = screen.getByRole("button", { name: "About Idle stop" });
		fireEvent.click(button);
		fireEvent.click(button);
		expect(tip()).toBeNull();
	});
});

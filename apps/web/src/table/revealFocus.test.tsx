import { fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { expect, test, vi } from "vitest";
import { revealFocused } from "./revealFocus.js";

/** Stub what the browser decides, since jsdom has no focus-visible heuristics. */
function watch(element: HTMLElement, focusVisible: boolean) {
	const scroll = vi.fn();
	element.scrollIntoView = scroll;
	vi.spyOn(element, "matches").mockImplementation(
		(selector: string) => selector === ":focus-visible" && focusVisible,
	);
	return scroll;
}

function Box({ portal = false }: { portal?: boolean }) {
	const control = <button type="button">Revoke…</button>;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the table box under test
		<div data-testid="box" tabIndex={-1} onFocus={revealFocused}>
			{portal ? createPortal(control, document.body) : control}
		</div>
	);
}

test("a control the keyboard focuses inside the box is scrolled fully into view", () => {
	render(<Box />);
	const button = screen.getByRole("button", { name: "Revoke…" });
	const scroll = watch(button, true);
	fireEvent.focus(button);
	expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
});

test("a control focused by a click is left where it is", () => {
	render(<Box />);
	const button = screen.getByRole("button", { name: "Revoke…" });
	const scroll = watch(button, false);
	fireEvent.focus(button);
	expect(scroll).not.toHaveBeenCalled();
});

test("a focus in a portal opened from the box does not scroll", () => {
	render(<Box portal />);
	const button = screen.getByRole("button", { name: "Revoke…" });
	const scroll = watch(button, true);
	fireEvent.focus(button);
	expect(scroll).not.toHaveBeenCalled();
});

test("focusing the box itself does not scroll it", () => {
	render(<Box />);
	const box = screen.getByTestId("box");
	const scroll = watch(box, true);
	fireEvent.focus(box);
	expect(scroll).not.toHaveBeenCalled();
});

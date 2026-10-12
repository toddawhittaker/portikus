import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { revealFocused } from "./revealFocus.js";

test("a control focused inside the box is scrolled fully into view on both axes", () => {
	render(
		// biome-ignore lint/a11y/noStaticElementInteractions: the table box under test
		<div onFocus={revealFocused}>
			<button type="button">Revoke…</button>
		</div>,
	);
	const button = screen.getByRole("button", { name: "Revoke…" });
	const scroll = vi.fn();
	button.scrollIntoView = scroll;
	fireEvent.focus(button);
	expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
});

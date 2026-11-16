import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { AssistantComposer } from "./AssistantComposer.js";

afterEach(cleanup);

const props = { onSend: () => true, onStop: () => {}, disabled: false };

test("when a turn ends while Stop has focus, focus goes to the message box rather than to nowhere", () => {
	const { rerender } = render(<AssistantComposer {...props} running />);
	const stop = screen.getByRole("button", { name: "Stop" });
	stop.focus();
	rerender(<AssistantComposer {...props} running={false} />);
	expect(document.activeElement).toBe(
		screen.getByRole("textbox", { name: "Message the assistant" }),
	);
});

test("a turn that ends while focus is elsewhere leaves it there", () => {
	const { rerender } = render(
		<>
			<button type="button">Elsewhere</button>
			<AssistantComposer {...props} running />
		</>,
	);
	const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
	elsewhere.focus();
	rerender(
		<>
			<button type="button">Elsewhere</button>
			<AssistantComposer {...props} running={false} />
		</>,
	);
	expect(document.activeElement).toBe(elsewhere);
});

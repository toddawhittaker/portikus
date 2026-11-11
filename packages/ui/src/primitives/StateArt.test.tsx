import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState.js";
import { StateArt } from "./StateArt.js";

describe("StateArt", () => {
	it("is hidden from assistive technology, as the heading beside it says what it means", () => {
		render(<StateArt icon="terminal" />);
		expect(screen.getByTestId("state-art").getAttribute("aria-hidden")).toBe("true");
	});

	it("shows the state's glyph in a badge only when given one", () => {
		const { rerender } = render(<StateArt icon="alert" />);
		expect(
			screen.getByTestId("state-art").querySelector("[data-icon=alert]"),
		).not.toBeNull();
		rerender(<StateArt />);
		expect(screen.getByTestId("state-art").querySelector(".pk-art-badge")).toBeNull();
	});

	it("takes the error tone and the busy cursor when asked", () => {
		render(<StateArt icon="alert" tone="error" busy />);
		const art = screen.getByTestId("state-art");
		expect(art.className).toContain("pk-art--error");
		expect(art.className).toContain("pk-art--busy");
	});

	it("is the picture above every empty state that has an icon", () => {
		render(<EmptyState icon="play" title="Nothing is running yet" />);
		expect(
			screen.getByTestId("state-art").querySelector("[data-icon=play]"),
		).not.toBeNull();
		expect(
			screen.getByRole("heading", { name: "Nothing is running yet" }),
		).toBeDefined();
	});
});

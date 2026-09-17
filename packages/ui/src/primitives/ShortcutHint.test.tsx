import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ShortcutHint } from "./ShortcutHint.js";

describe("ShortcutHint", () => {
	it("splits the keys into one keycap each", () => {
		const { container } = render(<ShortcutHint keys={["Mod", "Shift", "F"]} />);
		expect([...container.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual([
			"Ctrl",
			"Shift",
			"F",
		]);
	});

	it("uses the macOS glyphs on macOS", () => {
		const { container } = render(
			<ShortcutHint keys={["Mod", "Alt", "T"]} platform="mac" />,
		);
		expect([...container.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual([
			"⌘",
			"⌥",
			"T",
		]);
	});

	it("speaks one label for the whole group", () => {
		render(<ShortcutHint keys={["Mod", "Shift", "F"]} />);
		// role="img" makes the group a leaf, so the caps are not read one by one.
		expect(
			screen.getByRole("img", { name: "Shortcut: Control Shift F" }),
		).toBeDefined();
	});
});

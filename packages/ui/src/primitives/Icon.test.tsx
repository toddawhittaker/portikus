import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "./Icon.js";

describe("Icon", () => {
	it("renders the requested name and hides itself from assistive technology", () => {
		const { container } = render(<Icon name="terminal" />);
		const svg = container.querySelector("svg");
		expect(svg?.getAttribute("aria-hidden")).toBe("true");
		// The terminal glyph is a rounded rect plus the prompt strokes.
		expect(container.querySelector("rect")).not.toBeNull();
		expect(container.querySelectorAll("path")).toHaveLength(2);
	});

	it("draws the pencil as a barrel outline and a tip stroke", () => {
		const { container } = render(<Icon name="pencil" />);
		expect(container.querySelectorAll("path")).toHaveLength(2);
	});

	it("draws each file family as its own glyph", () => {
		const families = [
			"file",
			"file-code",
			"file-web",
			"file-style",
			"file-data",
			"file-markdown",
			"file-image",
			"file-archive",
			"file-config",
		] as const;
		const drawn = families.map((name) => {
			const { container } = render(<Icon name={name} />);
			return container.querySelector("svg")?.innerHTML;
		});
		// No two families share a drawing, the web and style ones above all.
		expect(new Set(drawn).size).toBe(families.length);
	});

	it("becomes an image with a name when labelled", () => {
		render(<Icon name="alert" label="Error" />);
		expect(screen.getByRole("img", { name: "Error" })).toBeDefined();
	});
});

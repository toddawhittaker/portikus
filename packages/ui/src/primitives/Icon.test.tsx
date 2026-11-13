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
			"file-web",
			"file-style",
			"file-data",
			"file-markdown",
			"file-image",
			"file-archive",
			"file-config",
			"file-text",
			"file-pdf",
			"file-sheet",
			"file-notebook",
			"file-audio",
			"file-video",
			"file-font",
			"file-lock",
			"file-key",
			"file-database",
			"file-binary",
			"file-slides",
			"file-log",
			"folder",
			"folder-open",
		] as const;
		const drawn = families.map((name) => {
			const { container } = render(<Icon name={name} />);
			return container.querySelector("svg")?.innerHTML;
		});
		// No two families share a drawing, the web and style ones above all.
		expect(new Set(drawn).size).toBe(families.length);
	});

	it("stamps a source file's page with its language tag", () => {
		const tags = {
			"file-python": "py",
			"file-java": "jv",
			"file-javascript": "js",
			"file-typescript": "ts",
			"file-c": "c",
			"file-cpp": "c++",
			"file-sql": "sql",
			"file-shell": "sh",
			"file-go": "go",
			"file-rust": "rs",
			"file-csharp": "c#",
			"file-ruby": "rb",
			"file-php": "php",
			"file-kotlin": "kt",
			"file-swift": "sw",
			"file-pdf": "pdf",
		} as const;
		for (const [name, tag] of Object.entries(tags)) {
			const { container } = render(<Icon name={name as keyof typeof tags} />);
			const text = container.querySelector("text");
			expect(text?.textContent, name).toBe(tag);
			// The tag is filled, not stroked, so it reads as letters.
			expect(text?.getAttribute("stroke")).toBe("none");
			// A long tag is fitted to the glyph's width, so no icon is wider.
			if (tag.length > 2) expect(text?.getAttribute("textLength")).toBe("20");
			// The same page sits behind every tag.
			expect(container.querySelectorAll("path")).toHaveLength(2);
		}
	});

	it("becomes an image with a name when labelled", () => {
		render(<Icon name="alert" label="Error" />);
		expect(screen.getByRole("img", { name: "Error" })).toBeDefined();
	});
});

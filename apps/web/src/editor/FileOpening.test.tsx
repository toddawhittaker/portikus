import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { FileOpening } from "./FileOpening.js";

test("names the file and draws a hidden page of placeholder lines", () => {
	const { container } = render(<FileOpening name="app.py" />);
	expect(screen.getByText("Opening app.py…")).toBeDefined();
	const lines = container.querySelector(".pk-file-opening-lines");
	expect(lines?.getAttribute("aria-hidden")).toBe("true");
	expect(lines?.querySelectorAll(".pk-skel").length).toBeGreaterThan(5);
});

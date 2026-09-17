import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NameMark } from "./NameMark.js";

describe("NameMark", () => {
	it("renders the name as text", () => {
		render(<NameMark size={18} />);
		expect(screen.getByText("Portikus")).toBeDefined();
	});

	it("links home when given an href", () => {
		render(<NameMark size={18} href="/" />);
		const link = screen.getByRole("link", { name: "Portikus" });
		expect(link.getAttribute("href")).toBe("/");
	});

	it("names itself when only the mark is shown", () => {
		render(<NameMark size={18} markOnly={true} />);
		expect(screen.getByRole("img", { name: "Portikus" })).toBeDefined();
	});
});

import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Home } from "./Home";

test("renders the product name", () => {
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no api")));
	render(<Home />);
	expect(screen.getByRole("heading", { name: "Portikus" })).toBeDefined();
});

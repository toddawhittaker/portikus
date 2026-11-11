import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./Badge.js";

describe("Badge", () => {
	it("shows its label with the tone's colours", () => {
		render(<Badge tone="warning">Needs your input</Badge>);
		const badge = screen.getByText("Needs your input");
		expect(badge.dataset.tone).toBe("warning");
		expect(badge.className).toContain("bg-status-warning-soft");
		expect(badge.className).toContain("text-status-warning");
	});

	it("passes through attributes such as a role", () => {
		render(
			<Badge tone="success" role="status">
				Passed
			</Badge>,
		);
		expect(screen.getByRole("status").textContent).toBe("Passed");
	});
});

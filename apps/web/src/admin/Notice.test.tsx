import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Notice } from "./Notice.js";

test.each([
	["warning", "bg-status-warning-soft", "text-status-warning"],
	["error", "bg-status-error-soft", "text-status-error"],
] as const)("a %s notice has its status fill and icon colour", (tone, fill, icon) => {
	render(
		<Notice tone={tone} testId="notice">
			Check this.
		</Notice>,
	);
	const notice = screen.getByTestId("notice");
	expect(notice.tagName).toBe("P");
	expect(notice.classList.contains(fill)).toBe(true);
	expect(notice.querySelector(`.${icon} svg`)).not.toBeNull();
	expect(notice.textContent).toBe("Check this.");
});

test("a pending notice spins instead of showing the alert icon", () => {
	render(
		<Notice tone="pending" testId="notice">
			Working.
		</Notice>,
	);
	const notice = screen.getByTestId("notice");
	expect(notice.classList.contains("bg-status-starting-soft")).toBe(true);
	expect(notice.querySelector(".pk-spin")).not.toBeNull();
	expect(notice.querySelector("svg")).toBeNull();
});

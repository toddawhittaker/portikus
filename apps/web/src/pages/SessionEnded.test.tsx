import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { SessionEnded } from "./SessionEnded.js";

test("the page names both ways a session ends, the 12-hour limit for provider roles included", () => {
	render(<SessionEnded />);
	const page = screen.getByTestId("page-session-ended");
	expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
		"Your session ended",
	);
	// Provider-role sessions end after 12 hours (SPEC.md section 24.13); the page is not told why it ended.
	expect(page.textContent).toContain(
		"If you are an administrator or instructor through your institution's sign-in, you are also signed out 12 hours after you sign in.",
	);
	expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe(
		"/auth/login",
	);
});

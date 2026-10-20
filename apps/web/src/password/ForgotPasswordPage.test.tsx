/**
 * The forgot-password page (SPEC.md section 5.3): its error and its answer
 * each take focus, so a screen reader hears them (SPEC.md section 25.8).
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch } from "../test-utils.js";

afterEach(() => vi.unstubAllGlobals());

test("an empty address is marked invalid before focus lands on the field", async () => {
	stubFetch((url) => {
		throw new Error(`unexpected request: ${url}`);
	});
	renderApp("/forgot-password");
	const field = await screen.findByLabelText("Email address");
	let invalidOnFocus: string | null = null;
	field.addEventListener("focus", () => {
		invalidOnFocus = field.getAttribute("aria-invalid");
	});

	fireEvent.click(screen.getByRole("button", { name: "Email me a link" }));

	expect(document.activeElement).toBe(field);
	expect(invalidOnFocus).toBe("true");
	expect(
		document.getElementById(field.getAttribute("aria-describedby") ?? "")?.textContent,
	).toContain("Enter the email address you sign in with.");
});

test("the confirmation that replaces the form takes focus", async () => {
	const bodies: unknown[] = [];
	stubFetch((url, init) => {
		if (url === "/auth/password-reset") {
			bodies.push(JSON.parse(String(init?.body)));
			return json(200, {});
		}
		throw new Error(`unexpected request: ${url}`);
	});
	renderApp("/forgot-password");
	fireEvent.change(await screen.findByLabelText("Email address"), {
		target: { value: " pat@example.edu " },
	});
	fireEvent.click(screen.getByRole("button", { name: "Email me a link" }));

	const status = await screen.findByRole("status");
	expect(status.textContent).toContain("a link is on its way");
	await waitFor(() => expect(document.activeElement).toBe(status));
	expect(bodies).toEqual([{ login: "pat@example.edu" }]);
});

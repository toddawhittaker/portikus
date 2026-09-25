/** The change-password form (SPEC.md sections 5.3 and 25.8). */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../test-utils.js";
import {
	ChangePasswordForm,
	checkPasswords,
	NEW_PASSWORD_HINT,
} from "./ChangePasswordForm.js";

afterEach(() => vi.unstubAllGlobals());

const GOOD = "correct horse battery staple";

function fill(current: string, next: string, confirm = next) {
	fireEvent.change(screen.getByLabelText("Current password"), {
		target: { value: current },
	});
	fireEvent.change(screen.getByLabelText("New password"), { target: { value: next } });
	fireEvent.change(screen.getByLabelText("New password again"), {
		target: { value: confirm },
	});
	fireEvent.click(screen.getByRole("button", { name: "Change password" }));
}

test("the rules: 15 characters, at most 72 bytes, different, typed twice", () => {
	expect(checkPasswords("", GOOD, GOOD)).toEqual({
		current: "Enter your current password.",
	});
	expect(checkPasswords("old", "short", "short").next).toBe(
		"Use at least 15 characters.",
	);
	expect(checkPasswords("old", "é".repeat(40), "é".repeat(40)).next).toMatch(
		/at most 72 bytes/,
	);
	expect(checkPasswords(GOOD, GOOD, GOOD).next).toBe(
		"Choose a password different from the current one.",
	);
	expect(checkPasswords("old", GOOD, `${GOOD}x`)).toEqual({
		confirm: "The two new passwords do not match.",
	});
	expect(checkPasswords("old", GOOD, GOOD)).toEqual({});
});

test("a short password is refused before sending, with the rule on the field", async () => {
	const fetch = stubFetch(() => json(500, {}));
	renderWithQuery(<ChangePasswordForm idPrefix="t" onChanged={() => {}} />);
	const next = screen.getByLabelText("New password");
	expect(next.getAttribute("aria-describedby")).toContain("t-next-hint");
	expect(screen.getByText(NEW_PASSWORD_HINT)).toBeTruthy();

	fill("old password", "short");

	expect(document.activeElement).toBe(next);
	expect(next.getAttribute("aria-invalid")).toBe("true");
	expect(screen.getByText("Use at least 15 characters.").id).toBe("t-next-err");
	expect(fetch).not.toHaveBeenCalled();
});

test("a wrong current password is shown on that field and it keeps focus", async () => {
	stubFetch(() =>
		json(403, {
			code: "WRONG_PASSWORD",
			message: "The current password is not right.",
		}),
	);
	const onChanged = vi.fn();
	renderWithQuery(<ChangePasswordForm idPrefix="t" onChanged={onChanged} />);

	fill("not it", GOOD);

	const current = screen.getByLabelText("Current password");
	await waitFor(() => expect(current.getAttribute("aria-invalid")).toBe("true"));
	expect(document.activeElement).toBe(current);
	expect(screen.getByText("The current password is not right.").id).toBe(
		"t-current-err",
	);
	expect(onChanged).not.toHaveBeenCalled();
});

test("too many tries is announced as an alert", async () => {
	stubFetch(() =>
		json(429, { code: "RATE_LIMITED", message: "Too many wrong passwords." }),
	);
	renderWithQuery(<ChangePasswordForm idPrefix="t" onChanged={() => {}} />);
	fill("not it", GOOD);
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Too many wrong passwords.",
	);
});

test("a good change sends both passwords once, clears the form and reports back", async () => {
	const fetch = stubFetch(() => new Response(null, { status: 204 }));
	const onChanged = vi.fn();
	renderWithQuery(<ChangePasswordForm idPrefix="t" onChanged={onChanged} />);

	fill("the old one-time pw", GOOD);

	await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
	expect(fetch).toHaveBeenCalledTimes(1);
	const [url, init] = fetch.mock.calls[0] ?? [];
	expect(url).toBe("/me/password");
	expect(init?.method).toBe("POST");
	expect(JSON.parse(String(init?.body))).toEqual({
		currentPassword: "the old one-time pw",
		newPassword: GOOD,
	});
	expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe("");
});

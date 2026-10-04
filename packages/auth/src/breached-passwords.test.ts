import { expect, test } from "vitest";
import { isBreachedPassword } from "./breached-passwords.js";

/** New passwords are checked against known-breached ones (SPEC.md section 24.13). */

test("refuses a listed password in any case", () => {
	expect(isBreachedPassword("passwordpassword")).toBe(true);
	expect(isBreachedPassword("PasswordPassword")).toBe(true);
	expect(isBreachedPassword("1q2w3e4r5t6y7u8i")).toBe(true);
	expect(isBreachedPassword("correct horse battery staple")).toBe(true);
});

test("accepts a password that is not listed", () => {
	expect(isBreachedPassword("violet-tram-orbit-lantern")).toBe(false);
	// A listed password with something added is not the listed password.
	expect(isBreachedPassword("passwordpassword!x")).toBe(false);
});

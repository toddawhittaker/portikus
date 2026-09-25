import { expect, test } from "vitest";
import { ChangePasswordRequest } from "./auth.js";

function newPasswordOk(newPassword: string): boolean {
	return ChangePasswordRequest.safeParse({ currentPassword: "x", newPassword }).success;
}

test("a new password needs 15 characters, counted as code points", () => {
	// Eight emoji are sixteen UTF-16 units but only eight characters.
	expect(newPasswordOk("\u{1F600}".repeat(8))).toBe(false);
	expect(newPasswordOk("\u{1F600}".repeat(15))).toBe(true);
	expect(newPasswordOk("a".repeat(14))).toBe(false);
	expect(newPasswordOk("a".repeat(15))).toBe(true);
});

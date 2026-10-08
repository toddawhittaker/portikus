import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Known-breached passwords a new password is checked against (SPEC.md
 * section 24.13, ADR 0054). scripts/generate-breached-passwords.mjs writes
 * the list already lower-cased and limited to 15+ characters. It lives
 * outside src/ because the Debian package drops every src/ directory.
 */
const LIST_PATH = fileURLToPath(
	new URL("../data/breached-passwords.txt", import.meta.url),
);

const BREACHED = new Set(readFileSync(LIST_PATH, "utf8").split("\n").filter(Boolean));

// A truncated file would silently accept every password; stop the process instead.
if (BREACHED.size < 10_000)
	throw new Error("breached-password list is missing entries");

/** True when the password is on the bundled list; case is ignored. */
export function isBreachedPassword(password: string): boolean {
	return BREACHED.has(password.toLowerCase());
}

/** What a person is told when a new password is refused for this. */
export const BREACHED_PASSWORD_MESSAGE =
	"That password appears in lists of leaked passwords, so attackers try it first. Choose a different one.";

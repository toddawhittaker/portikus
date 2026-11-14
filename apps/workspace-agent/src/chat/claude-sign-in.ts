import { execFile } from "node:child_process";
import type { ChatSignIn } from "@portikus/contracts";

/** `claude auth status` answers at once; a hung one is given up on. */
const AUTH_STATUS_TIMEOUT_MS = 10_000;

/** Its JSON is short; anything longer is not the answer. */
const AUTH_STATUS_MAX_BYTES = 64 * 1024;

/**
 * Whether the student is signed in to Claude Code, as `claude auth status`
 * says. It reads Claude Code's own sign-in, starts no turn, and exits 1
 * when signed out, so its output is read whatever the exit code. Only the
 * `loggedIn` flag is kept: the output also names the account, which is
 * never logged (ADR 0012). A missing binary or an unreadable answer gives
 * `unknown`.
 */
export function readClaudeSignIn(claudePath: string, cwd: string): Promise<ChatSignIn> {
	return new Promise((resolve) => {
		execFile(
			claudePath,
			["auth", "status", "--json"],
			{
				cwd,
				env: process.env,
				timeout: AUTH_STATUS_TIMEOUT_MS,
				maxBuffer: AUTH_STATUS_MAX_BYTES,
			},
			(_error, stdout) => resolve(signInFromStatus(String(stdout ?? ""))),
		);
	});
}

function signInFromStatus(output: string): ChatSignIn {
	try {
		const loggedIn = (JSON.parse(output) as { loggedIn?: unknown } | null)?.loggedIn;
		if (loggedIn === true) return "signedIn";
		if (loggedIn === false) return "signedOut";
	} catch {
		// Not the JSON this Claude Code version should print.
	}
	return "unknown";
}

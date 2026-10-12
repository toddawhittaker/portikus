import { CloseCode } from "@portikus/contracts";

/**
 * What the helper's terminal does when the API closes its socket (ADR 0063):
 * reattach at once in the new mode, stop for good, wait for the student, or
 * stay closed because another tab took the terminal over.
 */
export type HelperCloseAction = "reconnect" | "ended" | "away" | "replaced";

/** The live help action for a close code, or null to leave it to the ordinary retry rules. */
export function helperCloseAction(code: number): HelperCloseAction | null {
	switch (code) {
		case CloseCode.LIVE_HELP_MODE_CHANGED:
			return "reconnect";
		case CloseCode.LIVE_HELP_ENDED:
			return "ended";
		case CloseCode.LIVE_HELP_REPLACED:
			return "replaced";
		// The student closed every browser or the workspace stopped; the session is still open.
		case CloseCode.POLICY:
			return "away";
		default:
			return null;
	}
}

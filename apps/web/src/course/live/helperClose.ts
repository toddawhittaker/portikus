import { CloseCode } from "@portikus/contracts";

/**
 * What the helper's terminal does when the API closes its socket (ADR 0063):
 * reattach at once in the new mode, stop for good, or wait for the student.
 */
export type HelperCloseAction = "reconnect" | "ended" | "away";

/** The live help action for a close code, or null to leave it to the ordinary retry rules. */
export function helperCloseAction(code: number): HelperCloseAction | null {
	switch (code) {
		case CloseCode.LIVE_HELP_MODE_CHANGED:
			return "reconnect";
		case CloseCode.LIVE_HELP_ENDED:
			return "ended";
		// The student closed every browser or the workspace stopped; the session is still open.
		case CloseCode.POLICY:
			return "away";
		default:
			return null;
	}
}

/**
 * For a socket frame its schema refused: an error frame still ends the
 * stream, keeping its code when it has one; anything else is ignored, so a
 * newer server's frames never break an older page.
 */
export function unparsedFrame(
	message: unknown,
): { kind: "error"; code: string } | { kind: "ignored" } {
	if (typeof message !== "object" || message === null) return { kind: "ignored" };
	const { type, code } = message as { type?: unknown; code?: unknown };
	if (type !== "error") return { kind: "ignored" };
	return { kind: "error", code: typeof code === "string" ? code : "unknown" };
}

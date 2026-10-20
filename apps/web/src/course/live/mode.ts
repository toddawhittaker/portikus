/** The words for whether the student lets their instructor type (ADR 0063). */
export function modeText(typing: boolean): string {
	return typing ? "Typing allowed" : "Viewing only";
}

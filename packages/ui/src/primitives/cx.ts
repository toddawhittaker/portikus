/** Joins the truthy class names. */
export function cx(...parts: (string | false | undefined | null)[]): string {
	return parts.filter(Boolean).join(" ");
}

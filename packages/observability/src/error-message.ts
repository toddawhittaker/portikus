/** The message of an Error, or the thrown value as a string. */
export function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** A field error, announced when it appears (SPEC.md §25.8). */
export function announced(error: string | null) {
	return error ? <span role="alert">{error}</span> : null;
}

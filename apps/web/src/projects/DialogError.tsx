import { ApiError } from "../api/request.js";

/**
 * The error pattern from SPEC.md §28: what happened in the student's terms
 * first, the technical detail underneath.
 */
export function DialogError({ error }: { error: unknown }) {
	if (!error) return null;
	const sentence =
		error instanceof ApiError
			? error.message
			: "Something went wrong. Please try again.";
	const detail = error instanceof ApiError ? error.code : undefined;

	return (
		<div
			data-testid="dialog-error"
			role="alert"
			className="mt-4 rounded-md bg-status-error-soft p-3"
		>
			<p className="pk-text-body m-0 text-ink">{sentence}</p>
			{detail ? <p className="pk-techdetail mt-2">{detail}</p> : null}
		</div>
	);
}

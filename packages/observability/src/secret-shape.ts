/**
 * Shapes of a credential pasted into a message: the log scrub's bearer
 * token and URL credentials (redact.ts), held to a stricter form so code
 * that only names them passes, plus a PEM private key and a JSON
 * "private_key" field, as in a Google service-account key file.
 */
const SECRET_SHAPES: readonly RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/"private_key"\s*:\s*"/,
	/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/,
	/:\/\/[^/@\s:]+:[^/@\s]+@/,
];

/** Whether `text` holds something shaped like a secret (SPEC.md section 24). */
export function looksLikeSecret(text: string): boolean {
	return SECRET_SHAPES.some((shape) => shape.test(text));
}

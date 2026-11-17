/**
 * Shapes of a credential pasted into a message: the log scrub's bearer
 * token and URL credentials (redact.ts), held to a stricter form so code
 * that only names them passes, plus a PEM private key and a JSON
 * "private_key" field, as in a Google service-account key file, and the
 * client secrets and API keys a sign-in or provider setup is likely to see
 * pasted: Microsoft Entra and Google OAuth client secrets, model provider
 * keys, and a Portikus API key.
 */
const SECRET_SHAPES: readonly RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/"private_key"\s*:\s*"/,
	/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/,
	/:\/\/[^/@\s:]+:[^/@\s]+@/,
	// Entra client secret (the gitleaks Azure rule): 3 characters, a digit, "Q~", 31 to 34 more.
	/[A-Za-z0-9_~.]{3}\dQ~[A-Za-z0-9_~.-]{31,34}/,
	// Google OAuth client secret.
	/\bGOCSPX-[A-Za-z0-9_-]{20,}/,
	// Model provider API key, OpenAI-style "sk-" or Anthropic "sk-ant-".
	/\bsk-(ant-)?[A-Za-z0-9_-]{20,}/,
	// Portikus API key: API_KEY_PREFIX plus 32 random bytes as 43 base64url characters.
	/\bportikus_[A-Za-z0-9_-]{40,}/,
];

/** Whether `text` holds something shaped like a secret (SPEC.md section 24). */
export function looksLikeSecret(text: string): boolean {
	return SECRET_SHAPES.some((shape) => shape.test(text));
}

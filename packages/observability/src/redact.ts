/**
 * Key names whose values never appear in a log line or on the Logs tab
 * (SPEC.md §24.8, §24.11; BROWSER-HANDLING.md §21.3). Query, fragment and
 * userinfo are the URL parts that can carry a token; the two API key names
 * are institutional credentials.
 */
export const SENSITIVE_KEYS: readonly string[] = [
	"authorization",
	"cookie",
	"token",
	"agent_token",
	"agentToken",
	"clientSecret",
	"query",
	"fragment",
	"userinfo",
	"institutionalEnv",
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"set-cookie",
	"secret",
	"password",
	"sessionToken",
	"access_token",
	"refresh_token",
	"id_token",
	"SESSION_SECRET",
	"SESSION_COOKIE_SECRET",
	"CONTROLLER_TOKEN",
	"AGENT_TOKEN",
	"OIDC_CLIENT_SECRET",
	"DATABASE_URL",
];

/** Strings longer than this are cut on display. */
export const MAX_DISPLAY_STRING = 2000;

const sensitive = new Set(SENSITIVE_KEYS.map((key) => key.toLowerCase()));

// A bearer token or the user:password part of a URL inside any string.
const BEARER = /\bBearer\s+\S+/gi;
const URL_USERINFO = /:\/\/[^/@\s]+@/g;

function scrub(text: string): string {
	return text
		.replace(BEARER, "Bearer [redacted]")
		.replace(URL_USERINFO, "://[redacted]@");
}

/**
 * A copy of a parsed log line with every sensitive key's value (any letter
 * case) replaced by "[redacted]" at any depth, bearer tokens and URL
 * credentials inside strings scrubbed, and long strings cut (docs/adr/0036).
 */
export function redactLine(value: unknown): unknown {
	if (typeof value === "string") {
		const text = scrub(value);
		return text.length > MAX_DISPLAY_STRING
			? `${text.slice(0, MAX_DISPLAY_STRING)}…`
			: text;
	}
	if (Array.isArray(value)) return value.map(redactLine);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value)) {
			out[key] = sensitive.has(key.toLowerCase()) ? "[redacted]" : redactLine(inner);
		}
		return out;
	}
	return value;
}

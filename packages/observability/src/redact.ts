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
];

/** Strings longer than this are cut on display. */
export const MAX_DISPLAY_STRING = 2000;

const sensitive = new Set(SENSITIVE_KEYS);

/**
 * A copy of a parsed log line with every sensitive key's value replaced by
 * "[redacted]" at any depth and long strings cut (docs/adr/0036).
 */
export function redactLine(value: unknown): unknown {
	if (typeof value === "string") {
		return value.length > MAX_DISPLAY_STRING
			? `${value.slice(0, MAX_DISPLAY_STRING)}…`
			: value;
	}
	if (Array.isArray(value)) return value.map(redactLine);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value)) {
			out[key] = sensitive.has(key) ? "[redacted]" : redactLine(inner);
		}
		return out;
	}
	return value;
}

import { describe, expect, test } from "vitest";
import { looksLikeSecret } from "./secret-shape.js";

// Test strings are built at run time so no realistic key sits in the source.
const entraSecret = "abc" + "8Q~" + "x".repeat(34);
const googleSecret = "GOCSPX" + "-" + "a".repeat(28);
const modelKey = "sk" + "-" + "a".repeat(24);
const anthropicKey = "sk" + "-ant-" + "a".repeat(24);
const portikusKey = "portikus" + "_" + "A1b2".repeat(11).slice(0, 43);

// Key headers are built at run time so the repository's secret scan does not flag this file.
const BEGIN = (kind: string) => `-----BEGIN ${kind}KEY-----`;
const END = (kind: string) => `-----END ${kind}KEY-----`;

/** A message is refused before it is stored or sent to a provider (SPEC.md section 24). */
describe("a message that looks like a secret", () => {
	test.each([
		[
			"a PEM private key",
			`is this right?\n${BEGIN("PRIVATE ")}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n${END("PRIVATE ")}`,
		],
		["an RSA private key header alone", `${BEGIN("RSA PRIVATE ")}\nMIIE`],
		[
			"a service-account JSON key",
			'{"type": "service_account", "project_id": "x", "private_key_id": "abc", "private_key": "-----BEGIN',
		],
		["a private_key field without its block", '{ "private_key" : "MIIEvQIBADANBgkq" }'],
		["a bearer token", "it fails with Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc"],
		["a URL with a password", "DATABASE_URL=postgres://portikus:hunter2pass@db:5432/x"],
		["an Entra client secret", `the secret is ${entraSecret} in the portal`],
		["a Google OAuth client secret", `client secret: ${googleSecret}`],
		["a model API key", `OPENAI_API_KEY=${modelKey}`],
		["an Anthropic API key", `key ${anthropicKey} fails`],
		["a Portikus API key", `Authorization: ${portikusKey}`],
	])("%s is refused", (_, text) => {
		expect(looksLikeSecret(text)).toBe(true);
	});

	test.each([
		["ordinary text", "Why can't Alice sign in? She says the page loops."],
		[
			"a question about keys",
			"Where do I put the private key for the service account?",
		],
		[
			"code with no key in it",
			'const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });\nconst key = process.env.PRIVATE_KEY;',
		],
		["a URL with a user name only", "clone ssh://git@github.com/org/repo.git"],
		["a plain URL", "the issuer is https://login.microsoftonline.com/abc/v2.0"],
		["the word bearer", "the bearer of bad news"],
		[
			"a JSON key name that only mentions private_key",
			"the field private_key_id is set",
		],
		["a short Entra-like value", "abc8Q~" + "x".repeat(20)],
		["the Entra marker in prose", "the 8Q~ marker appears in secret ids"],
		["a short Google prefix", "GOCSPX- is the prefix Google uses"],
		["sk- in prose", "the sk-learn docs and a risk-averse task-based plan"],
		["a short sk- value", "sk-" + "a".repeat(10)],
		["a short portikus_ identifier", "the portikus_session cookie and portikus_ping tool"],
		["a long portikus_ word with a space", "portikus_ " + "a".repeat(50)],
	])("%s is allowed", (_, text) => {
		expect(looksLikeSecret(text)).toBe(false);
	});
});

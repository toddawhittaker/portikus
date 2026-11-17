import { describe, expect, test } from "vitest";
import { looksLikeSecret } from "./secret-shape.js";

/** A message is refused before it is stored or sent to a provider (SPEC.md section 24). */
describe("a message that looks like a secret", () => {
	test.each([
		[
			"a PEM private key",
			"is this right?\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
		],
		["an RSA private key header alone", "-----BEGIN RSA PRIVATE KEY-----\nMIIE"],
		[
			"a service-account JSON key",
			'{"type": "service_account", "project_id": "x", "private_key_id": "abc", "private_key": "-----BEGIN',
		],
		["a private_key field without its block", '{ "private_key" : "MIIEvQIBADANBgkq" }'],
		["a bearer token", "it fails with Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc"],
		["a URL with a password", "DATABASE_URL=postgres://portikus:hunter2pass@db:5432/x"],
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
	])("%s is allowed", (_, text) => {
		expect(looksLikeSecret(text)).toBe(false);
	});
});

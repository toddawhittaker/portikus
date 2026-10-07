import { expect, request as newRequest, test } from "@playwright/test";
import { createSignedInUser, E2E_ANONYMOUS_LIMIT } from "./helpers";
import { API_ORIGIN } from "./ports";

// An address of its own, so no other spec's requests share its count.
const ADDRESS = "198.51.100.77";

test("a burst on an anonymous route gets 429 RATE_LIMITED; a signed-in user at that address is unaffected", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const api = await newRequest.newContext({
		baseURL: API_ORIGIN,
		extraHTTPHeaders: { "x-forwarded-for": ADDRESS },
	});
	const batch = 100;
	for (let sent = 0; sent < E2E_ANONYMOUS_LIMIT; sent += batch) {
		const answers = await Promise.all(
			Array.from({ length: batch }, () => api.get("/lti/jwks")),
		);
		for (const answer of answers) expect(answer.status()).not.toBe(429);
	}
	const refused = await api.get("/lti/jwks");
	expect(refused.status()).toBe(429);
	expect(await refused.json()).toEqual({
		code: "RATE_LIMITED",
		message: "Too many requests from your network just now. Try again in a minute.",
	});
	expect(Number(refused.headers()["retry-after"])).toBeGreaterThan(0);
	await api.dispose();

	await createSignedInUser(page.context(), "student");
	const me = await page.request.get("/auth/me", {
		headers: { "x-forwarded-for": ADDRESS },
	});
	expect(me.status()).toBe(200);
});

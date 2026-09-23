/**
 * Every launch that is wrong in one way is refused, gets a page saying so,
 * and leaves no session (docs/EPIC-13.md rulings 16, 19 and 22).
 */
import { expect, type Page, type Response, test } from "@playwright/test";
import { query, WEB_ORIGIN } from "./helpers";
import { type Defect, launchAs, signedIn, startLaunch } from "./lti-helpers";

/** The reason code the API must record for each mock defect (ruling 19). */
const REASONS: Record<Defect, string> = {
	bad_signature: "bad_signature",
	wrong_aud: "wrong_audience",
	expired: "expired",
	replayed_nonce: "nonce_mismatch",
	unknown_deployment: "unknown_deployment",
	wrong_message_type: "wrong_message_type",
	wrong_version: "wrong_version",
	alg_none: "alg_not_allowed",
	wrong_target: "wrong_target",
};

async function failedLaunchReasons(since: Date): Promise<string[]> {
	const rows = await query<{ reason: string }>(
		`select metadata->>'reason' as reason from audit_events
		 where action = 'auth.login' and result = 'failed'
		   and metadata->>'method' = 'lti' and at >= $1`,
		[since],
	);
	return rows.map((r) => r.reason);
}

// Token failures answer 401, state problems 400.
async function expectRefused(page: Page, launched: Promise<Response>, status: number) {
	const response = await launched;
	expect(response.status()).toBe(status);
	// A server-rendered page that says so, not the app and not a blank error.
	await expect(page.getByRole("heading").first()).toBeVisible();
	await expect(page.getByTestId("app-header")).toHaveCount(0);
	expect(await signedIn(page)).toBe(false);
	const cookies = await page.context().cookies(WEB_ORIGIN);
	expect(cookies.map((c) => c.name)).not.toContain("portikus_session");
}

function launchResponse(page: Page) {
	return page.waitForResponse(
		(r) => r.url() === `${WEB_ORIGIN}/lti/launch` && r.request().method() === "POST",
	);
}

for (const defect of Object.keys(REASONS) as Defect[]) {
	test(`a launch with ${defect} is refused with no session`, async ({
		page,
		browser,
	}) => {
		if (defect === "replayed_nonce") {
			// The mock replays its previous token, so a good launch goes first.
			const other = await browser.newContext({ baseURL: WEB_ORIGIN });
			await launchAs(await other.newPage(), { person: "lee" });
			await other.close();
		}
		const since = new Date(Date.now() - 1000);
		const launched = launchResponse(page);
		await startLaunch(page, { person: "lee", defect });
		await expectRefused(page, launched, 401);
		await expect.poll(() => failedLaunchReasons(since)).toContain(REASONS[defect]);
	});
}

test("a launch that arrives without the state cookie is refused with the reopen page", async ({
	page,
}) => {
	const since = new Date(Date.now() - 1000);
	// A cross-site form post of a made-up token, as a login-CSRF attempt would be.
	await page.setContent(
		`<form method="post" action="${WEB_ORIGIN}/lti/launch">
		   <input type="hidden" name="id_token" value="not.a.token">
		   <input type="hidden" name="state" value="made-up-state">
		   <button type="submit">Post</button>
		 </form>`,
	);
	const launched = launchResponse(page);
	await page.getByRole("button", { name: "Post" }).click();
	await expectRefused(page, launched, 400);
	await expect(page.getByText("Portikus could not finish opening here.")).toBeVisible();
	await expect.poll(() => failedLaunchReasons(since)).toContain("state_missing");
});

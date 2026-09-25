/**
 * A launch inside the LMS's frame never starts the flow there; it offers a
 * new tab (docs/archive/epics/EPIC-13.md rulings 16 and 17).
 */
import { expect, test } from "@playwright/test";
import { query, WEB_ORIGIN } from "./helpers";
import { MOCK_LMS_ORIGIN, signedIn, startLaunch } from "./lti-helpers";

test("a launch in a frame offers a new tab, and the new tab signs in", async ({
	page,
	context,
}) => {
	const loginInFrame = page.waitForResponse(
		(r) =>
			r.url().startsWith(`${WEB_ORIGIN}/lti/login`) && r.frame() !== page.mainFrame(),
	);
	await startLaunch(page, { person: "sam", frame: true });
	const response = await loginInFrame;

	// Any page may frame it, since framed it only offers a new tab; its
	// form may post only to us or the platform.
	expect(response.status()).toBe(200);
	const csp = response.headers()["content-security-policy"] ?? "";
	expect(csp).toContain("frame-ancestors *");
	expect(csp).toContain(`form-action 'self' ${MOCK_LMS_ORIGIN}`);
	// The flow did not start: no state cookie, no redirect to the platform.
	expect(response.headers()["set-cookie"] ?? "").not.toContain("lti_state");

	const frame = page.frameLocator('iframe[title="Portikus"]');
	const open = frame.getByRole("button", { name: "Open Portikus in a new tab" });
	await expect(open).toBeVisible();
	await expect(frame.getByRole("heading")).toBeVisible();
	expect(await signedIn(page)).toBe(false);

	const [tab] = await Promise.all([context.waitForEvent("page"), open.click()]);
	await tab.waitForURL(`${WEB_ORIGIN}/**`, { timeout: 15_000 });
	await expect(tab.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });
	const me = await tab.request.get(`${WEB_ORIGIN}/auth/me`);
	expect(me.status()).toBe(200);
	expect(((await me.json()) as { displayName: string }).displayName).toBe(
		"Sam Student",
	);
});

test("a launch posted inside a frame is refused and writes no audit row", async ({
	page,
}) => {
	const since = new Date(Date.now() - 1000);
	const launched = page.waitForResponse(
		(r) => r.url() === `${WEB_ORIGIN}/lti/launch` && r.request().method() === "POST",
	);
	// A frame that posts a launch straight to Portikus, as a hostile page could.
	const form = `<form method="post" action="${WEB_ORIGIN}/lti/launch">
		<input type="hidden" name="id_token" value="not.a.token">
		<input type="hidden" name="state" value="framed-state">
		<button type="submit">Post</button></form>`;
	// A real web origin as the parent; an opaque about:blank one matches no
	// frame-ancestors source.
	await page.goto(`${MOCK_LMS_ORIGIN}/`);
	await page.setContent(`<iframe title="host" srcdoc='${form}'></iframe>`);
	await page
		.frameLocator('iframe[title="host"]')
		.getByRole("button", { name: "Post" })
		.click();
	const response = await launched;

	expect(response.status()).toBe(400);
	expect(response.headers()["content-security-policy"] ?? "").toContain(
		"frame-ancestors *",
	);
	await expect(
		page
			.frameLocator('iframe[title="host"]')
			.getByText("Portikus could not finish opening here."),
	).toBeVisible();
	expect(await signedIn(page)).toBe(false);
	const rows = await query(
		`select id from audit_events
		 where action = 'auth.login' and metadata->>'method' = 'lti'
		   and metadata->>'reason' = 'framed' and at >= $1`,
		[since],
	);
	expect(rows).toEqual([]);
});

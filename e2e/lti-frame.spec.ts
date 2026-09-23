/**
 * A launch inside the LMS's frame never starts the flow there; it offers a
 * new tab (docs/EPIC-13.md rulings 16 and 17).
 */
import { expect, test } from "@playwright/test";
import { WEB_ORIGIN } from "./helpers";
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

	// The frame may be the platform's origin only, never anyone else's.
	expect(response.status()).toBe(200);
	const csp = response.headers()["content-security-policy"] ?? "";
	expect(csp).toContain("frame-ancestors");
	expect(csp).toContain(MOCK_LMS_ORIGIN);
	expect(csp).not.toContain("*");
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

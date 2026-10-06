import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers";

/**
 * The Send test alert button on the Settings tab (STACK.md section 15). The
 * e2e API has no notify.json, so every channel is off (ADR 0052). Delivery
 * to each channel is tested in the API's and the worker's unit tests.
 */
test("with no channel set up, the button says nothing was sent", async ({ page }) => {
	await loginAs(page, "carol");
	await page.goto("/admin/settings");
	const section = page.getByTestId("alerts-section");
	await expect(section.getByRole("heading", { name: "Alerts" })).toBeVisible();
	await section.getByRole("button", { name: "Send test alert" }).click();
	await expect(page.getByTestId("test-alert-result")).toContainText(
		"No alert channel is set up, so nothing was sent.",
	);
});

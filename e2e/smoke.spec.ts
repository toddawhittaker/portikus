import { expect, test } from "@playwright/test";

// TODO(Epic 6): "/" becomes the sign-in page (plan, E1); the product name
// is then the NameMark in its header.
test("the web shell renders the product name", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Portikus" })).toBeVisible();
});

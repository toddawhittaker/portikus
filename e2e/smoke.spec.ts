import { expect, test } from "@playwright/test";

test("the web shell renders the product name", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Portikus" })).toBeVisible();
});

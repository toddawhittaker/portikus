import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers";

/**
 * The service log level lives on the Logs page beside Auto refresh, next to
 * the lines it decides (SPEC.md section 20.1, ADR 0012).
 */
test.use({ viewport: { width: 1440, height: 900 } });

test("the service log level sits on the toolbar beside Auto refresh, above the lines", async ({
	page,
}) => {
	await loginAs(page, "carol");
	await page.goto("/admin/logs");
	const auto = page.getByRole("button", { name: "Auto refresh" });
	const level = page.getByRole("combobox", { name: "Services log at" });
	await expect(auto).toBeVisible({ timeout: 15_000 });
	await expect(level).toBeEnabled();

	const autoBox = await auto.boundingBox();
	const levelBox = await level.boundingBox();
	if (!autoBox || !levelBox) throw new Error("a control has no box");
	// One row: the two overlap vertically, the level to the right.
	expect(levelBox.y).toBeLessThan(autoBox.y + autoBox.height);
	expect(autoBox.y).toBeLessThan(levelBox.y + levelBox.height);
	expect(levelBox.x).toBeGreaterThan(autoBox.x + autoBox.width);

	// The level's own Save is on that row too, and the keyboard reaches the level after Auto refresh.
	const save = page.getByTestId("log-level-form").getByRole("button", { name: "Save" });
	const saveBox = await save.boundingBox();
	if (!saveBox) throw new Error("Save has no box");
	expect(saveBox.y).toBeLessThan(autoBox.y + autoBox.height);
	await auto.focus();
	for (let step = 0; step < 6; step++) {
		if (await level.evaluate((select) => select === document.activeElement)) break;
		await page.keyboard.press("Tab");
	}
	await expect(level).toBeFocused();

	// It lives on Logs only, so Settings has no second copy.
	await page.goto("/admin/settings");
	await expect(page.getByTestId("settings-sections")).toBeVisible({ timeout: 15_000 });
	await expect(page.getByRole("combobox", { name: "Services log at" })).toHaveCount(0);
});

import { expect, type Locator, type Page, test } from "@playwright/test";
import { loginAs } from "./helpers";

/** The Settings tab layout (docs/EPIC-18.md ruling 15, issue #601). */
test.describe("admin settings layout", () => {
	test.use({ viewport: { width: 1920, height: 1080 } });

	async function bottom(locator: Locator): Promise<number> {
		const box = await locator.boundingBox();
		if (!box) throw new Error("not visible");
		return box.y + box.height;
	}

	async function top(locator: Locator): Promise<number> {
		const box = await locator.boundingBox();
		if (!box) throw new Error("not visible");
		return box.y;
	}

	async function open(page: Page) {
		await loginAs(page, "carol");
		await page.goto("/admin?tab=settings");
		await expect(page.getByTestId("guard-settings-save")).toBeEnabled({
			timeout: 15_000,
		});
	}

	test("cards sit in a grid under the Settings heading", async ({ page }) => {
		await open(page);
		await expect(
			page.getByRole("heading", { level: 2, name: "Settings", exact: true }),
		).toBeVisible();
		const cards = page.getByTestId("settings-grid").locator(":scope > section");
		await expect(cards).toHaveCount(5);
		// At 1920 px the first two cards share a row.
		expect(await top(cards.nth(1))).toBe(await top(cards.nth(0)));
	});

	test("every Save sits below its fields", async ({ page }) => {
		await open(page);
		const pairs: [string, string][] = [
			["grace-input", "grace-save"],
			["idle-input", "idle-save"],
			["settings-throttleSharePercent", "guard-settings-save"],
			["aup-text", "aup-save"],
			["log-level-select", "log-level-save"],
		];
		for (const [field, save] of pairs) {
			expect(await top(page.getByTestId(save))).toBeGreaterThan(
				await bottom(page.getByTestId(field)),
			);
		}
	});

	test("resource guard inputs are 192 px wide", async ({ page }) => {
		await open(page);
		for (const key of [
			"cpuThresholdPercent",
			"memoryThresholdPercent",
			"windowMinutes",
			"throttleSharePercent",
		]) {
			const box = await page.getByTestId(`settings-${key}`).boundingBox();
			expect(box?.width).toBe(192);
		}
	});
});

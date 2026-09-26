import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { loginAs, query } from "./helpers";

/** The admin frame every tab shares (docs/EPIC-18.md rulings 1-10, SPEC.md §20.1). */
test.describe("admin layout", () => {
	test.use({ viewport: { width: 1920, height: 1080 } });

	test("content is capped at 1440 px, compact, and each tab has its own h2 and title", async ({
		page,
	}) => {
		await loginAs(page, "carol");
		await page.goto("/admin");

		const main = page.getByTestId("page-admin");
		await expect(main).toHaveAttribute("data-density", "compact", { timeout: 15_000 });
		const box = await page.getByTestId("admin-content").boundingBox();
		expect(box?.width).toBeLessThanOrEqual(1440);
		expect(box?.width).toBeGreaterThan(1400);

		for (const [tab, name] of [
			["workspaces", "Users"],
			["audit", "Audit"],
			["health", "Health"],
			["settings", "Settings"],
		] as const) {
			await page.getByTestId(`admin-tab-${tab}`).click();
			await expect(
				main.getByRole("heading", { level: 2, name, exact: true }),
			).toBeVisible();
			await expect(page).toHaveTitle(`${name}, Administration, Portikus`);
		}
	});

	test("a secondary button shows its border", async ({ page }) => {
		await loginAs(page, "carol");
		await page.goto("/admin?tab=audit");
		const clear = page.getByTestId("audit-filter-clear");
		await expect(clear).toBeVisible({ timeout: 15_000 });
		const color = await clear.evaluate((el) => getComputedStyle(el).borderTopColor);
		expect(color).not.toBe("rgba(0, 0, 0, 0)");
		expect(color).not.toBe("transparent");
	});

	test("the Audit table header stays in view when the page scrolls", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 600 });
		const workspaceId = randomUUID();
		await query(
			`insert into audit_events (actor, target, action, result, metadata, at)
			 select 'system', $1, 'workspace.stop_requested', 'success', '{}'::jsonb,
			        now() - make_interval(secs => 50 - n)
			 from generate_series(1, 50) as n order by n`,
			[workspaceId],
		);
		await loginAs(page, "carol");
		await page.goto(`/admin?tab=audit&workspace=${workspaceId}`);

		const table = page.getByTestId("audit-table");
		await expect(table.locator("tbody tr")).toHaveCount(50, { timeout: 15_000 });
		const main = page.getByTestId("page-admin");
		await main.evaluate((el) => el.scrollBy(0, 800));

		const header = table.locator("thead th").first();
		const mainBox = await main.boundingBox();
		const headerBox = await header.boundingBox();
		expect(mainBox).not.toBeNull();
		expect(headerBox).not.toBeNull();
		if (!mainBox || !headerBox) return;
		// Stuck inside <main>'s 32 px padding, while the first row has scrolled away above it.
		expect(headerBox.y).toBeGreaterThanOrEqual(mainBox.y - 1);
		expect(headerBox.y).toBeLessThan(mainBox.y + 40);
		const firstRow = await table.locator("tbody tr").first().boundingBox();
		expect(firstRow?.y ?? 0).toBeLessThan(mainBox.y);
	});
});

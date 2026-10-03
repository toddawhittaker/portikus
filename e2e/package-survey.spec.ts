import { expect, type Page, test } from "@playwright/test";
import {
	createStudent,
	loginAs,
	openToggletip,
	query,
	settledAxe,
	WCAG_TAGS,
} from "./helpers";

/**
 * "Packages students add" on the Workspace image tab (SPEC.md §20.1, ADR 0042). No
 * worker runs in e2e, so each test writes the counts the survey would. The
 * tests share those tables, so they run one after another.
 */
test.describe.configure({ mode: "serial" });

async function clear(): Promise<void> {
	await query("delete from package_survey_days");
}

async function seedDay(day: string, surveyed: number, counts: Record<string, number>) {
	await query("insert into package_survey_days (day, surveyed) values ($1, $2)", [
		day,
		surveyed,
	]);
	for (const [name, workspaces] of Object.entries(counts)) {
		await query(
			"insert into package_survey_counts (day, package, workspaces) values ($1, $2, $3)",
			[day, name, workspaces],
		);
	}
}

async function openImage(page: Page): Promise<void> {
	await loginAs(page, "carol");
	await page.goto("/admin/image");
	await expect(
		page.getByRole("heading", { level: 2, name: "Workspace image", exact: true }),
	).toBeVisible({ timeout: 15_000 });
}

test.describe("package survey", () => {
	test.beforeEach(clear);
	test.afterAll(clear);

	test("the section is on the Workspace image tab, not on Health", async ({ page }) => {
		await loginAs(page, "carol");
		await page.goto("/admin/health");
		await expect(page.getByTestId("health")).toBeVisible({ timeout: 15_000 });
		await expect(
			page.getByRole("heading", { name: "Packages students add" }),
		).toHaveCount(0);
	});

	test("before any survey the section says so", async ({ page }) => {
		await openImage(page);
		await expect(
			page.getByRole("heading", { level: 3, name: "Packages students add" }),
		).toBeVisible();
		await expect(page.getByTestId("packages-empty")).toHaveText(
			"No workspace has been surveyed yet.",
		);
	});

	test("the table shows the latest day's counts and marks candidates", async ({
		page,
	}) => {
		await seedDay("2026-09-23", 8, { "python3-venv": 4, cowsay: 1 });
		await seedDay("2026-09-26", 9, { "python3-venv": 6, htop: 2 });

		await openImage(page);

		const table = page.getByTestId("packages-table");
		await expect(table.locator("caption")).toContainText(
			"9 workspaces surveyed on 26 September 2026",
		);
		const rows = table.getByTestId("packages-row");
		await expect(rows).toHaveCount(3);
		const venv = rows.filter({ hasText: "python3-venv" });
		await expect(venv).toContainText("Base-image candidate");
		await expect(venv).toContainText("6 of 9");
		await expect(venv).toContainText("23 September 2026");
		// Two of nine is under a third: counted, not a candidate.
		const htop = rows.filter({ hasText: "htop" });
		await expect(htop).toContainText("2 of 9");
		await expect(htop).not.toContainText("candidate");
		// Not added by anyone on the latest day: 0, with the day it was last seen.
		await expect(rows.filter({ hasText: "cowsay" })).toContainText("0 of 9");

		await table.getByRole("button", { name: "About Base-image candidate" }).click();
		await expect(openToggletip(page)).toContainText("on the latest survey day");
		const results = await (await settledAxe(page))
			.include('[aria-labelledby="image-packages-title"]')
			.include(".pk-toggletip-content")
			.withTags(WCAG_TAGS)
			.analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	});

	test("a student is refused the counts", async ({ page, context }) => {
		await createStudent(context);
		const response = await page.request.get("/admin/packages");
		expect(response.status()).toBe(403);
	});
});

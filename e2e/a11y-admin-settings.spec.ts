import { expect, type Page, test } from "@playwright/test";
import { expectNoViolations, expectReflowAt320, loginAs, routeApi } from "./helpers";

/**
 * Accessibility of the Settings tab (SPEC.md section 25.8), in both themes:
 * the loaded page, its loading and failed-load states, the leave dialog,
 * the "Coming later" rows and the estimate with server memory unknown.
 * Each unit is read with its field. Nothing here saves, so no lock is taken.
 */

async function open(page: Page) {
	await loginAs(page, "carol");
	await page.goto("/admin/settings");
	await expect(page.getByTestId("settings-idleStopMinutes")).not.toHaveValue("", {
		timeout: 15_000,
	});
	await expect(page.getByTestId("notify-loading")).toHaveCount(0);
}

for (const colorScheme of ["light", "dark"] as const) {
	test.describe(`in the ${colorScheme} theme`, () => {
		test.beforeEach(async ({ page }) => {
			await page.emulateMedia({ colorScheme });
		});

		test("the loaded page, with unsaved changes, has no violations", async ({
			page,
		}) => {
			await open(page);
			await page.getByTestId("settings-idleStopMinutes").fill("45");
			await page
				.getByRole("region", { name: "Student tools" })
				.getByRole("checkbox", { name: "Python" })
				.click();
			await expect(page.getByTestId("settings-tools-state")).toHaveText(
				"1 unsaved change",
			);
			await expectNoViolations(page);
		});

		test("the loading skeletons have no violations", async ({ page }) => {
			let hold: () => void = () => {};
			const held = new Promise<void>((done) => {
				hold = done;
			});
			await routeApi(page, "**/admin/settings", async (route, request) => {
				if (request.method() !== "GET") return route.fallback();
				await held;
				return route.fallback();
			});
			await loginAs(page, "carol");
			await page.goto("/admin/settings");
			await expect(
				page.getByTestId("settings-stop").locator("[aria-busy='true']"),
			).toBeVisible({ timeout: 15_000 });
			await expectNoViolations(page);
			hold();
		});

		test("the failed-load notice has no violations", async ({ page }) => {
			await routeApi(page, "**/admin/settings", async (route, request) => {
				if (request.method() !== "GET") return route.fallback();
				return route.fulfill({ status: 500, json: {} });
			});
			await loginAs(page, "carol");
			await page.goto("/admin/settings");
			await expect(page.getByRole("alert")).toContainText(
				"These settings could not be loaded.",
				{ timeout: 30_000 },
			);
			await expectNoViolations(page);
		});

		test("the leave dialog has no violations", async ({ page }) => {
			await open(page);
			await page.getByTestId("settings-idleStopMinutes").fill("45");
			await expect(page.getByTestId("settings-stop-state")).toHaveText(
				"1 unsaved change",
			);
			await page
				.getByRole("navigation", { name: "Administration" })
				.getByRole("link", { name: "Users", exact: true })
				.click();
			await expect(
				page.getByRole("alertdialog", { name: "Leave without saving?" }),
			).toBeVisible();
			await expectNoViolations(page);
		});

		test("the estimate with server memory unknown, and a focused Coming later row, have no violations", async ({
			page,
		}) => {
			await routeApi(page, "**/admin/health", async (route, request) => {
				if (request.method() !== "GET") return route.fallback();
				const response = await route.fetch();
				return route.fulfill({
					response,
					json: { ...(await response.json()), host: null },
				});
			});
			await open(page);
			await expect(page.getByTestId("code-help-estimate")).toContainText(
				"Server memory not known yet",
			);
			await page.getByRole("checkbox", { name: "Java", exact: true }).focus();
			await expectNoViolations(page, "[data-testid='settings-tools']");
		});
	});
}

test("each number field is read with its unit", async ({ page }) => {
	await open(page);
	await expect(
		page.getByRole("textbox", { name: "Disconnect grace" }),
	).toHaveAccessibleDescription(/^minutes\b/);
	await expect(
		page.getByRole("textbox", { name: "Longest keep running" }),
	).toHaveAccessibleDescription(/^hours\b/);
});

test("the page reflows at 320 px with no sideways scrolling", async ({ page }) => {
	await open(page);
	await expectReflowAt320(page);
});

test("the estimate's headline is the only live part of it", async ({ page }) => {
	await open(page);
	const estimate = page.getByTestId("code-help-estimate");
	await expect(estimate.locator("output")).toHaveCount(1);
	await expect(
		estimate.locator("[aria-live], [role='status'], [role='alert']"),
	).toHaveCount(0);
});

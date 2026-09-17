import { expect, type Page, test } from "@playwright/test";
import { loginAs, query } from "./helpers";

/**
 * The administration page: the live disconnect grace period and the
 * per-user override (SPEC.md §6.4, §20.1). Carol is the mock provider's
 * administrator; alice and bob are students.
 *
 * These tests share one settings row, so they run one after another.
 */
test.describe.configure({ mode: "serial" });

test.describe("administration", () => {
	async function openAdmin(page: Page): Promise<void> {
		await loginAs(page, "carol");
		await page.goto("/admin");
		await expect(page.getByTestId("page-admin")).toBeVisible({ timeout: 15_000 });
	}

	async function aliceId(): Promise<string> {
		const rows = await query<{ id: string }>(
			"select id from users where display_name = $1",
			["Alice Student"],
		);
		const id = rows[0]?.id;
		if (!id) throw new Error("alice has not logged in yet");
		return id;
	}

	test.afterAll(async () => {
		// Leave the platform on its default, whatever the tests did.
		await query("update settings set shutdown_grace_seconds = 600");
	});

	test("an administrator changes the platform grace period", async ({ page }) => {
		await openAdmin(page);

		const input = page.getByTestId("grace-input");
		await expect(input).toHaveValue(/\d+/);
		await input.fill("0");
		await expect(
			page.getByText("Workspaces keep running until stopped by hand").first(),
		).toBeVisible();
		await page.getByTestId("grace-save").click();

		await expect(page.getByText("Grace period saved")).toBeVisible();

		await page.reload();
		await expect(page.getByTestId("grace-input")).toHaveValue("0");

		// Put it back through the page itself, so the saved value is checked twice.
		await page.getByTestId("grace-input").fill("600");
		await page.getByTestId("grace-save").click();
		await expect(page.getByText("Grace period saved")).toBeVisible();
		await page.reload();
		await expect(page.getByTestId("grace-input")).toHaveValue("600");
		await expect(page.getByText("10 minutes").first()).toBeVisible();
	});

	test("an administrator sets and clears one student's override", async ({ page }) => {
		// Alice has to exist as a row before she can be given an override.
		await loginAs(page, "alice");
		const alice = await aliceId();
		await page.getByTestId("me").click();
		await page.getByTestId("signout").click();
		await expect(page.getByTestId("signin")).toBeVisible();
		await openAdmin(page);

		const input = page.getByTestId(`user-grace-input-${alice}`);
		await input.fill("30");
		await page.getByTestId(`user-grace-save-${alice}`).click();

		await expect
			.poll(async () => {
				const rows = await query<{ shutdown_grace_seconds: number | null }>(
					"select shutdown_grace_seconds from users where id = $1",
					[alice],
				);
				return rows[0]?.shutdown_grace_seconds ?? null;
			})
			.toBe(30);
		await page.reload();
		await expect(page.getByTestId(`user-grace-input-${alice}`)).toHaveValue("30");

		await page.getByTestId(`user-grace-input-${alice}`).fill("");
		await page.getByTestId(`user-grace-save-${alice}`).click();

		await expect
			.poll(async () => {
				const rows = await query<{ shutdown_grace_seconds: number | null }>(
					"select shutdown_grace_seconds from users where id = $1",
					[alice],
				);
				return rows[0]?.shutdown_grace_seconds ?? null;
			})
			.toBe(null);
		await page.reload();
		await expect(page.getByTestId(`user-grace-input-${alice}`)).toHaveValue("");
	});

	test("a student asking for /admin is turned away", async ({ page }) => {
		await loginAs(page, "bob");

		await page.goto("/admin");

		await expect(page).toHaveURL(/\/not-authorized$/, { timeout: 15_000 });
		await expect(page.getByTestId("page-not-authorized")).toBeVisible();
	});

	test("only an administrator sees the Administration link", async ({ page }) => {
		await loginAs(page, "carol");
		await expect(page.getByTestId("admin-link")).toBeVisible({ timeout: 15_000 });

		await page.getByTestId("me").click();
		await page.getByTestId("signout").click();
		await expect(page.getByTestId("signin")).toBeVisible();

		await loginAs(page, "alice");
		await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("admin-link")).toHaveCount(0);
	});
});

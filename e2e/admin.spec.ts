import { expect, type Page, test } from "@playwright/test";
import { loginAs, query, toast, WEB_ORIGIN } from "./helpers";

/**
 * The administration page: the live disconnect grace period and the
 * per-user override (SPEC.md §6.4, §20.1). Carol is the mock provider's
 * administrator; alice and bob are students.
 *
 * These tests share the one row in the settings table, so they run one after
 * another. For the same reason `--repeat-each` needs `--workers=1` here:
 * Playwright puts each repeat in its own group, and two groups running at
 * once overwrite each other's settings.
 */
test.describe.configure({ mode: "serial" });

test.describe("administration", () => {
	/** The grace period and log level live on the Settings tab (Epic 11). */
	async function openAdmin(page: Page, tab = "settings"): Promise<void> {
		await loginAs(page, "carol");
		await page.goto(`/admin?tab=${tab}`);
		await expect(page.getByTestId("page-admin")).toBeVisible({ timeout: 15_000 });
	}

	/** A user's grace override is in their detail panel on the Workspaces tab. */
	async function openAliceDetail(page: Page): Promise<void> {
		await page.getByTestId("admin-filter-text").fill("Alice Student");
		await page.getByRole("button", { name: "Show details for Alice Student" }).click();
		await expect(page.getByRole("region", { name: "Alice Student" })).toBeVisible();
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

	test.beforeAll(async () => {
		// No worker runs here, so seed the settings row the way the worker
		// does on its first start.
		await query(
			"insert into settings (id, shutdown_grace_seconds) values (1, 600) on conflict do nothing",
		);
	});

	test.beforeEach(async () => {
		// Every case starts from no log level override.
		await query("update settings set log_level = null");
	});

	test.afterAll(async () => {
		// Leave the platform on its default, whatever the tests did.
		await query("update settings set shutdown_grace_seconds = 600, log_level = null");
	});

	async function savedLogLevel(): Promise<string | null> {
		const rows = await query<{ log_level: string | null }>(
			"select log_level from settings where id = 1",
		);
		return rows[0]?.log_level ?? null;
	}

	test("an administrator changes the platform grace period", async ({ page }) => {
		await openAdmin(page);

		const input = page.getByTestId("grace-input");
		await expect(input).toHaveValue(/\d+/);
		await input.fill("0");
		await expect(
			page.getByText("Workspaces keep running until stopped by hand").first(),
		).toBeVisible();
		await page.getByTestId("grace-save").click();

		await expect(toast(page, "Grace period saved")).toBeVisible();

		await page.reload();
		await expect(page.getByTestId("grace-input")).toHaveValue("0");

		// Put it back through the page itself, so the saved value is checked twice.
		await page.getByTestId("grace-input").fill("600");
		await page.getByTestId("grace-save").click();
		await expect(toast(page, "Grace period saved")).toBeVisible();
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
		await openAdmin(page, "workspaces");
		await openAliceDetail(page);

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
		await openAliceDetail(page);
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
		await openAliceDetail(page);
		await expect(page.getByTestId(`user-grace-input-${alice}`)).toHaveValue("");
	});

	test("an administrator overrides and clears the log level", async ({ page }) => {
		await openAdmin(page);

		const select = page.getByTestId("log-level-select");
		await expect(select).toHaveValue("default");
		await select.selectOption("debug");
		await page.getByTestId("log-level-save").click();

		await expect(toast(page, "Log level saved")).toBeVisible();
		await expect.poll(savedLogLevel).toBe("debug");

		await page.reload();
		await expect(page.getByTestId("log-level-select")).toHaveValue("debug");

		await page.getByTestId("log-level-select").selectOption("default");
		await page.getByTestId("log-level-save").click();
		await expect(toast(page, "Log level saved")).toBeVisible();
		await expect.poll(savedLogLevel).toBe(null);

		await page.reload();
		await expect(page.getByTestId("log-level-select")).toHaveValue("default");
	});

	test("a student asking for /admin is turned away", async ({ page }) => {
		await loginAs(page, "bob");

		await page.goto("/admin");

		await expect(page).toHaveURL(/\/not-authorized$/, { timeout: 15_000 });
		await expect(page.getByTestId("page-not-authorized")).toBeVisible();
	});

	test("only an administrator sees the Administration link", async ({ page }) => {
		await loginAs(page, "carol");
		// An administrator lands on /admin; the link lives in the workspace (issue #534).
		await expect(page).toHaveURL(`${WEB_ORIGIN}/admin`, { timeout: 15_000 });
		await expect(page.getByTestId("back-to-workspace")).toHaveCount(0);
		await page.getByTestId("me").click();
		await page.getByRole("menuitem", { name: "Open my workspace" }).click();
		await expect(page).toHaveURL(/\/workspaces\//, { timeout: 15_000 });
		await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });

		await page.getByTestId("me").click();
		const link = page.getByTestId("admin-link");
		await expect(link).toBeVisible();
		await expect(link).toHaveAttribute("href", "/admin");
		// A new tab keeps this tab's sockets open, so the grace timer never starts.
		await expect(link).toHaveAttribute("target", "_blank");
		await expect(link).toHaveAttribute("rel", "noopener");

		await page.keyboard.press("Escape");
		await page.getByTestId("me").click();
		await page.getByTestId("signout").click();
		await expect(page.getByTestId("signin")).toBeVisible();

		await loginAs(page, "alice");
		// A student still lands in their own workspace.
		await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]{36}$/, { timeout: 15_000 });
		await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("me").click();
		await expect(page.getByTestId("admin-link")).toHaveCount(0);
	});
});

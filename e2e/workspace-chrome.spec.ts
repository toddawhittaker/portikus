import { expect, test } from "@playwright/test";
import { createStudent, query, workspacePath } from "./helpers";

/**
 * Shell chrome from the pilot (issues #327, #328, #329; SPEC.md §6, §13.5).
 * The status bar state opens the workspace dialog, the account button has
 * no role, and light, dark, or system appearance is chosen in Settings.
 */

test("the status bar state opens the workspace dialog", async ({ page, context }) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));

	const bar = page.getByTestId("status-bar");
	await expect(bar).toBeVisible({ timeout: 15_000 });
	await expect(bar).not.toContainText("Leave terminal");
	await expect(
		page.getByTestId("app-header").getByRole("button", { name: "Workspace" }),
	).toHaveCount(0);

	await expect(page.getByTestId("workspace-state")).toHaveText("Running");
	await page.getByTestId("workspace-status").click();
	await expect(page.getByTestId("dialog-workspace-status")).toBeVisible();
	await expect(page.getByTestId("workspace-restart")).toBeVisible();
	await expect(page.getByTestId("workspace-stop")).toBeVisible();
});

test("the account button shows the name and not the role", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));

	const account = page.getByTestId("me");
	await expect(account).toHaveText(/^ES\s+E2E Student$/, { timeout: 15_000 });
	await expect(account.locator(".pk-account-role")).toHaveCount(0);

	await account.click();
	await expect(page.getByRole("menu")).not.toContainText("Appearance");
	await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
	await expect(page.getByTestId("admin-link")).toHaveCount(0);
});

test("an administrator still reaches Administration, without a role label", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await query("update users set role = 'administrator' where id = $1", [
		student.userId,
	]);
	await page.goto(workspacePath(student.workspaceId));

	const account = page.getByTestId("me");
	await expect(account).toBeVisible({ timeout: 15_000 });
	await expect(account).not.toContainText("Administrator");
	await account.click();
	const link = page.getByTestId("admin-link");
	await expect(link).toBeVisible();
	await expect(link).toHaveAttribute("href", "/admin");
	await expect(link).toHaveAttribute("target", "_blank");
});

test("appearance is chosen in Settings and stays in this browser", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("me")).toBeVisible({ timeout: 15_000 });

	await page.getByTestId("me").click();
	await expect(page.getByRole("menuitem", { name: "Dark" })).toHaveCount(0);
	await page.getByRole("menuitem", { name: "Settings" }).click();

	const dialog = page.getByTestId("dialog-editor-settings");
	await expect(dialog.getByRole("heading", { name: "Appearance" })).toBeVisible();
	await expect(dialog.getByRole("heading", { name: "Terminal" })).toBeVisible();
	await expect(
		dialog.getByRole("switch", { name: "Terminal colors" }),
	).not.toBeChecked();
	await expect(page.locator("html")).toHaveAttribute("data-terminal-theme", "dark");

	// Light page, dark terminal: the two choices are independent (SPEC.md §13.5).
	await dialog
		.getByRole("group", { name: "Color scheme" })
		.getByRole("radio", { name: "Light" })
		.click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("pk-theme")))
		.toBe("light");
	await expect(page.locator("html")).toHaveAttribute("data-terminal-theme", "dark");
	await expect(
		dialog.getByRole("switch", { name: "Terminal colors" }),
	).not.toBeChecked();

	// It applied before Save, and Cancel does not take it back.
	await page.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

	await page.reload();
	await expect(page.getByTestId("me")).toBeVisible({ timeout: 15_000 });
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await expect(
		page
			.getByRole("group", { name: "Color scheme" })
			.getByRole("radio", { name: "Light" }),
	).toBeChecked();
	await page
		.getByRole("group", { name: "Color scheme" })
		.getByRole("radio", { name: "System" })
		.click();
	await expect(page.locator("html")).not.toHaveAttribute("data-theme");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("pk-theme")))
		.toBe("system");
	await expect(page.locator("html")).toHaveAttribute("data-terminal-theme", "dark");
});

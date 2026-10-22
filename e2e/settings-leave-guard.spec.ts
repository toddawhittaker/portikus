import { expect, type Page, test } from "@playwright/test";
import { loginAs } from "./helpers";

/**
 * Leaving the Settings tab with unsaved changes asks first (SPEC.md section
 * 20.1). The dialog names the sections and their counts and never a value,
 * which may be a secret. Nothing here saves, so no lock is taken.
 */

async function open(page: Page) {
	await loginAs(page, "carol");
	await page.goto("/admin/settings");
	await expect(page.getByTestId("settings-idleStopMinutes")).not.toHaveValue("", {
		timeout: 15_000,
	});
	await expect(page.getByTestId("notify-loading")).toHaveCount(0);
}

function usersLink(page: Page) {
	return page
		.getByRole("navigation", { name: "Administration" })
		.getByRole("link", { name: "Users", exact: true });
}

test("with nothing unsaved, another tab opens without asking", async ({ page }) => {
	await open(page);
	await usersLink(page).click();
	await expect(page).toHaveURL(/\/admin\/users/);
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("Stay on Settings keeps the edits; Leave without saving leaves", async ({
	page,
}) => {
	await open(page);
	await page.getByTestId("settings-idleStopMinutes").fill("47");
	await page.getByTestId("aup-text").fill("Secret-ish draft 9f3c");
	await page.getByRole("textbox", { name: "Measuring period" }).fill("41");
	await page.getByTestId("settings-shutdownGraceSeconds").fill("12");
	await expect(page.getByTestId("settings-stop-state")).toHaveText("2 unsaved changes");

	await usersLink(page).click();
	const dialog = page.getByRole("alertdialog", { name: "Leave without saving?" });
	await expect(dialog).toBeVisible();
	for (const line of [
		"When workspaces stop has 2 unsaved changes.",
		"Resource guard has 1 unsaved change.",
		"Acceptable use has 1 unsaved change.",
		"They are lost if you leave.",
	]) {
		await expect(dialog).toContainText(line);
	}
	// Names and counts only, never what was typed.
	for (const value of ["47", "41", "12", "9f3c"]) {
		await expect(dialog).not.toContainText(value);
	}
	await expect(dialog.getByRole("button", { name: "Stay on Settings" })).toBeFocused();

	await dialog.getByRole("button", { name: "Stay on Settings" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page).toHaveURL(/\/admin\/settings/);
	await expect(page.getByTestId("settings-idleStopMinutes")).toHaveValue("47");
	await expect(page.getByTestId("aup-text")).toHaveValue("Secret-ish draft 9f3c");

	// Escape is the same as staying.
	await usersLink(page).click();
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(page).toHaveURL(/\/admin\/settings/);

	await usersLink(page).click();
	await dialog.getByRole("button", { name: "Leave without saving" }).click();
	await expect(page).toHaveURL(/\/admin\/users/);
});

test("the browser's back button asks too", async ({ page }) => {
	await loginAs(page, "carol");
	await page.goto("/admin/users");
	await usersLink(page).waitFor();
	await page
		.getByRole("navigation", { name: "Administration" })
		.getByRole("link", { name: "Settings", exact: true })
		.click();
	await expect(page.getByTestId("settings-idleStopMinutes")).not.toHaveValue("", {
		timeout: 15_000,
	});
	await page.getByTestId("settings-idleStopMinutes").fill("52");
	await expect(page.getByTestId("settings-stop-state")).toHaveText("1 unsaved change");
	await page.goBack();
	const dialog = page.getByRole("alertdialog", { name: "Leave without saving?" });
	await expect(dialog).toContainText("When workspaces stop has 1 unsaved change.");
	await dialog.getByRole("button", { name: "Stay on Settings" }).click();
	await expect(page).toHaveURL(/\/admin\/settings/);
	await expect(page.getByTestId("settings-idleStopMinutes")).toHaveValue("52");
});

test("closing the browser tab with unsaved changes gets the browser's own prompt", async ({
	page,
}) => {
	await open(page);
	// A real click and keystrokes: Chromium shows the prompt only after the user has acted on the page.
	await page.getByTestId("settings-idleStopMinutes").click();
	await page.keyboard.press("ControlOrMeta+A");
	await page.keyboard.type("48");
	await expect(page.getByTestId("settings-stop-state")).toHaveText("1 unsaved change");
	const prompt = page.waitForEvent("dialog");
	await page.close({ runBeforeUnload: true });
	const dialog = await prompt;
	expect(dialog.type()).toBe("beforeunload");
	await dialog.dismiss();
});

test("after Discard changes, leaving does not ask", async ({ page }) => {
	await open(page);
	await page.getByTestId("settings-idleStopMinutes").fill("49");
	await expect(page.getByTestId("settings-stop-state")).toHaveText("1 unsaved change");
	await page.getByTestId("settings-stop-discard").click();
	await usersLink(page).click();
	await expect(page).toHaveURL(/\/admin\/users/);
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

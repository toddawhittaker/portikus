import crypto from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { createStudent, query, WEB_ORIGIN, workspacePath } from "./helpers";

/**
 * Appearance follows the student (issue #300, SPEC.md §13.5). The choice is a
 * per-user setting; this browser's `pk-theme` copy only covers the first
 * paint before the settings arrive.
 */

async function openSettings(page: Page) {
	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await expect(page.getByTestId("dialog-editor-settings")).toBeVisible();
}

test("a saved appearance applies in a fresh browser without a flash", async ({
	page,
	context,
	browser,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });

	await openSettings(page);
	const saved = page.waitForResponse(
		(response) =>
			response.url().endsWith("/me/settings") && response.request().method() === "PUT",
	);
	await page.getByRole("radio", { name: "Dark" }).check();
	expect((await saved).ok()).toBe(true);
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

	// A second browser: nothing in its storage, and a light operating system.
	const fresh = await browser.newContext({ colorScheme: "light" });
	try {
		const token = crypto.randomBytes(32).toString("base64url");
		await query(
			`insert into sessions (id, user_id, expires_at)
			 values ($1, $2, now() + interval '1 hour')`,
			[crypto.createHash("sha256").update(token).digest("hex"), student.userId],
		);
		await fresh.addCookies([
			{ name: "portikus_session", value: token, url: WEB_ORIGIN },
		]);
		// Records the theme at the moment the shell first appears.
		await fresh.addInitScript(() => {
			const record = window as unknown as { themeAtFirstPaint?: string | null };
			new MutationObserver((_changes, observer) => {
				if (document.querySelector("[data-testid=app-header]")) {
					record.themeAtFirstPaint =
						document.documentElement.getAttribute("data-theme");
					observer.disconnect();
				}
			}).observe(document, { childList: true, subtree: true });
		});

		const second = await fresh.newPage();
		await second.goto(workspacePath(student.workspaceId));
		await expect(second.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });

		expect(
			await second.evaluate(
				() => (window as unknown as { themeAtFirstPaint?: string }).themeAtFirstPaint,
			),
		).toBe("dark");
		await expect(second.locator("html")).toHaveAttribute("data-theme", "dark");
		// The cache is refreshed for the next first paint.
		expect(await second.evaluate(() => localStorage.getItem("pk-theme"))).toBe("dark");
	} finally {
		await fresh.close();
	}
});

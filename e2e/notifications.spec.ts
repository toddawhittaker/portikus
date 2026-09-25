/**
 * Toasts that time out, and the notification history behind the unread badge
 * on the account button (SPEC.md section 8.5, ADR 0033; issue #475).
 */
import crypto from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	query,
	settledAxe,
	toast,
	WEB_ORIGIN,
	workspacePath,
} from "./helpers";

async function expectNoViolations(page: Page, include: string) {
	const results = await (await settledAxe(page))
		.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
		.include(include)
		.analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** Delete a project through the UI; it answers with a "Project deleted" toast. */
async function deleteProject(page: Page, project: { id: string; slug: string }) {
	await page.getByTestId(`project-menu-${project.id}`).click();
	await page.getByRole("menuitem", { name: "Delete project" }).click();
	const dialog = page.getByTestId("dialog-delete-project");
	await dialog.getByRole("textbox").fill(project.slug);
	await dialog.getByTestId("dialog-confirm").click();
}

/** Record a notification as the browser would after showing a toast. */
async function record(page: Page, title: string, tone = "warning", body = "") {
	const res = await page.request.post("/me/notifications", {
		data: { tone, title, body },
		headers: { origin: WEB_ORIGIN },
	});
	expect(res.status()).toBe(201);
}

/** What the page does when the window regains focus: refetch now, not at the next poll. */
async function regainFocus(page: Page) {
	await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
}

test("a toast times out, is recorded, and the history follows the user to a second browser", async ({
	page,
	context,
	browser,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Short Lived" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(page.getByTestId(`project-item-${project.id}`)).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByTestId("notifications-badge")).toHaveCount(0);

	await deleteProject(page, project);
	const shown = toast(page, "Project deleted");
	await expect(shown).toBeVisible();
	// Move the pointer away: hovering a toast pauses its timer.
	await page.mouse.move(0, 0);
	await expect(shown).toHaveCount(0, { timeout: 10_000 });

	const badge = page.getByTestId("notifications-badge");
	await expect(badge).toHaveText("1");
	await expect(page.getByTestId("me")).toHaveAccessibleName(/1 unread notification$/);

	await badge.click();
	const dialog = page.getByTestId("dialog-notifications");
	const item = dialog
		.getByTestId("notification")
		.filter({ hasText: "Project deleted" });
	await expect(item).toHaveAttribute("data-unread", "true");
	await item.getByRole("button", { name: 'Mark "Project deleted" as read' }).click();
	await expect(item).toHaveAttribute("data-unread", "false");
	await expect(badge).toHaveCount(0);
	await page.keyboard.press("Escape");

	await page.reload();
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Notifications" }).click();
	await expect(
		dialog.getByTestId("notification").filter({ hasText: "Project deleted" }),
	).toBeVisible();
	await page.keyboard.press("Escape");

	// The same user signs in on a second browser.
	const other = await browser.newContext();
	try {
		const token = crypto.randomBytes(32).toString("base64url");
		await query(
			`insert into sessions (id, user_id, expires_at)
			 values ($1, $2, now() + interval '1 hour')`,
			[crypto.createHash("sha256").update(token).digest("hex"), student.userId],
		);
		await other.addCookies([
			{ name: "portikus_session", value: token, url: WEB_ORIGIN },
		]);
		const second = await other.newPage();
		await second.goto(workspacePath(student.workspaceId));
		await expect(second.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });

		await second.getByTestId("me").click();
		await second.getByRole("menuitem", { name: "Notifications" }).click();
		await expect(
			second
				.getByTestId("dialog-notifications")
				.getByTestId("notification")
				.filter({ hasText: "Project deleted" }),
		).toBeVisible();
		await second.keyboard.press("Escape");

		// A new one, unread in both; marking it read in one clears the other.
		await record(page, "Disk nearly full");
		await regainFocus(page);
		await regainFocus(second);
		await expect(page.getByTestId("notifications-badge")).toHaveText("1");
		await expect(second.getByTestId("notifications-badge")).toHaveText("1");

		await second.getByTestId("notifications-badge").click();
		await second.getByTestId("notifications-read-all").click();
		await expect(second.getByTestId("notifications-badge")).toHaveCount(0);

		await regainFocus(page);
		await expect(page.getByTestId("notifications-badge")).toHaveCount(0);
	} finally {
		await other.close();
	}
});

test("the badge reads 9+ above nine and Clear all empties the history", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	for (let i = 0; i < 10; i += 1) await record(page, `Message ${i}`);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("notifications-badge")).toHaveText("9+");
	await expect(page.getByTestId("me")).toHaveAccessibleName(/10 unread notifications$/);

	await page.getByTestId("notifications-badge").click();
	const dialog = page.getByTestId("dialog-notifications");
	// Newest first, and opening the dialog marks nothing read.
	await expect(dialog.getByTestId("notification").first()).toContainText("Message 9");
	await expect(page.getByTestId("notifications-badge")).toHaveText("9+");
	await dialog.getByTestId("notifications-clear").click();
	await expect(dialog.getByTestId("notifications-empty")).toBeVisible();
	await expect(page.getByTestId("notifications-badge")).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
	test(`the badge and the dialog pass automatic checks in the ${theme} theme`, async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const saved = await page.request.put("/me/settings", {
			data: { appearance: theme },
			headers: { origin: WEB_ORIGIN },
		});
		expect(saved.status()).toBe(200);
		await record(page, "Your workspace could not start", "danger", "Storage is full.");
		await record(page, "Link copied", "success");
		await page.goto(workspacePath(student.workspaceId));
		await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

		await expect(page.getByTestId("notifications-badge")).toHaveText("2");
		await expectNoViolations(page, "[data-testid=app-header]");

		await page.getByTestId("notifications-badge").click();
		await expect(page.getByTestId("notification")).toHaveCount(2);
		await expectNoViolations(page, "[data-testid=dialog-notifications]");
	});
}

test("keyboard only: reach Notifications from the account menu and mark one read", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await record(page, "First warning");
	await record(page, "Second warning");
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("notifications-badge")).toHaveText("2");

	await page.getByTestId("me").focus();
	await page.keyboard.press("Enter");
	const item = page.getByRole("menuitem", { name: /^Notifications/ });
	await expect(item).toBeVisible();
	// Arrow down to the item, then open it.
	for (let i = 0; i < 5; i += 1) {
		if (await item.evaluate((el) => el === document.activeElement)) break;
		await page.keyboard.press("ArrowDown");
	}
	await expect(item).toBeFocused();
	await page.keyboard.press("Enter");

	const dialog = page.getByTestId("dialog-notifications");
	await expect(dialog).toBeVisible();
	const markRead = dialog.getByRole("button", {
		name: 'Mark "Second warning" as read',
	});
	for (let i = 0; i < 10; i += 1) {
		if (await markRead.evaluate((el) => el === document.activeElement)) break;
		await page.keyboard.press("Tab");
	}
	await expect(markRead).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("notifications-badge")).toHaveText("1");

	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	// The badge is its own stop in the tab order and opens the dialog on Enter.
	await page.getByTestId("notifications-badge").focus();
	await page.keyboard.press("Enter");
	await expect(dialog).toBeVisible();
});

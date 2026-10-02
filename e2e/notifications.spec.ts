/**
 * Toasts that time out, and the notification history behind the unread badge
 * on the account button (SPEC.md section 8.5, ADR 0033).
 */
import crypto from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectNoViolations,
	query,
	toast,
	WEB_ORIGIN,
	workspacePath,
} from "./helpers";

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

/**
 * Regain focus until the badge matches. A focus refetch joins a fetch already
 * in flight, which may predate the change; the app then waits for the poll.
 */
async function expectBadgeAfterFocus(page: Page, unread: number) {
	const badge = page.getByTestId("notifications-badge");
	await expect(async () => {
		await regainFocus(page);
		if (unread === 0) await expect(badge).toHaveCount(0, { timeout: 1_000 });
		else await expect(badge).toHaveText(String(unread), { timeout: 1_000 });
	}).toPass();
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
	await expect(page.getByTestId("me")).toHaveAccessibleName(
		/\S, 1 unread notification$/,
	);

	await badge.click();
	const dialog = page.getByTestId("dialog-notifications");
	const item = dialog
		.getByTestId("notification")
		.filter({ hasText: "Project deleted" });
	await expect(item).toHaveAttribute("data-unread", "true");
	await item.getByRole("button", { name: 'Mark read: "Project deleted"' }).click();
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
		await expectBadgeAfterFocus(page, 1);
		await expectBadgeAfterFocus(second, 1);

		await second.getByTestId("notifications-badge").click();
		await second.getByTestId("notifications-read-all").click();
		await expect(second.getByTestId("notifications-badge")).toHaveCount(0);

		await expectBadgeAfterFocus(page, 0);
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
	await expect(page.getByTestId("me")).toHaveAccessibleName(
		/\S, 10 unread notifications$/,
	);

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
		name: 'Mark read: "Second warning"',
	});
	for (let i = 0; i < 10; i += 1) {
		if (await markRead.evaluate((el) => el === document.activeElement)) break;
		await page.keyboard.press("Tab");
	}
	await expect(markRead).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("notifications-badge")).toHaveText("1");
	// Its button is gone, so focus moves to the next unread item's Mark read.
	await expect(
		dialog.getByRole("button", { name: 'Mark read: "First warning"' }),
	).toBeFocused();

	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	// The badge is its own stop in the tab order and opens the dialog on Enter.
	await page.getByTestId("notifications-badge").focus();
	await page.keyboard.press("Enter");
	await expect(dialog).toBeVisible();
	// Closed without reading, focus goes back to the badge that opened it.
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(page.getByTestId("notifications-badge")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(dialog).toBeVisible();

	// Mark all as read keeps focus, though the badge that opened the dialog goes.
	const readAll = dialog.getByTestId("notifications-read-all");
	await readAll.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("notifications-badge")).toHaveCount(0);
	await expect(readAll).toBeFocused();
	await expect(readAll).toHaveAttribute("aria-disabled", "true");
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(page.getByTestId("me")).toBeFocused();
});

// The count sits after the name in the accent and never
// covers the picture; the menu names the count after "Notifications"; a long
// address does not widen the menu; an unread item's dot is the accent.
test("the badge sits after the account button, and the menu stays narrow", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const email = `${"a-long-address-part-".repeat(6)}${student.userId.slice(0, 8)}@students.example.edu`;
	await query("update users set email = $2 where id = $1", [student.userId, email]);
	await record(page, "Disk nearly full");
	await page.goto(workspacePath(student.workspaceId));

	const badge = page.getByTestId("notifications-badge");
	await expect(badge).toHaveText("1");
	const account = await page.getByTestId("me").boundingBox();
	const pill = await badge.boundingBox();
	expect(account && pill).toBeTruthy();
	if (!account || !pill) return;
	expect(pill.x).toBeGreaterThanOrEqual(account.x + account.width);
	expect(pill.height).toBeGreaterThanOrEqual(24);
	expect(pill.width).toBeGreaterThanOrEqual(24);
	const colors = await page.evaluate(() => {
		const style = getComputedStyle(document.documentElement);
		const probe = document.createElement("span");
		probe.style.background = style.getPropertyValue("--accent");
		document.body.append(probe);
		const accent = getComputedStyle(probe).backgroundColor;
		probe.remove();
		const pillEl = document.querySelector(".pk-account-badge-pill");
		return { accent, pill: pillEl ? getComputedStyle(pillEl).backgroundColor : "" };
	});
	expect(colors.pill).toBe(colors.accent);

	await page.getByTestId("me").click();
	const menu = page.getByRole("menu");
	await expect(
		menu.getByRole("menuitem", { name: "Notifications, 1 unread" }),
	).toBeVisible();
	const address = menu.getByTitle(email);
	await expect(address).toBeVisible();
	const menuBox = await menu.boundingBox();
	// 18rem for the address plus the menu's own padding.
	expect(menuBox?.width ?? 0).toBeLessThanOrEqual(18 * 16 + 40);
	expect(await address.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
	await page.keyboard.press("Escape");

	await badge.click();
	const dot = page.locator(".pk-notification-dot").first();
	await expect(dot).toBeVisible();
	expect(await dot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
		colors.accent,
	);
});

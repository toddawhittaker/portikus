/**
 * Desktop notifications in Settings > Preferences (SPEC.md section 25.8):
 * a three-way choice that is saved at once, asks the browser only when
 * "On" is chosen, and says so when the browser has blocked notifications.
 * Whether an alert fires on a hidden page is pinned by the unit tests,
 * which can fake the page state.
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createStudent,
	expectNoViolations,
	WEB_ORIGIN,
	workspacePath,
} from "./helpers";

async function openSettings(page: Page) {
	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	const dialog = page.getByTestId("dialog-editor-settings");
	await expect(dialog).toBeVisible();
	return dialog;
}

async function saved(page: Page): Promise<string> {
	const res = await page.request.get("/me/settings");
	return ((await res.json()) as { agentNotifications: string }).agentNotifications;
}

/** Make the browser undecided and count how often the page asks it. */
async function undecidedBrowser(page: Page, answer: NotificationPermission) {
	await page.addInitScript((reply) => {
		const counter = window as unknown as { __asked: number };
		counter.__asked = 0;
		Object.defineProperty(Notification, "permission", { get: () => "default" });
		Notification.requestPermission = async () => {
			counter.__asked += 1;
			return reply;
		};
	}, answer);
}

async function timesAsked(page: Page): Promise<number> {
	return page.evaluate(() => (window as unknown as { __asked: number }).__asked);
}

test("the choice starts at Ask me and Off saves at once", async ({ page, context }) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	const dialog = await openSettings(page);
	const group = dialog.getByRole("group", { name: "Desktop notifications" });
	await expect(group.getByRole("radio", { name: "Ask me" })).toBeChecked();
	await group.getByRole("radio", { name: "Off" }).check();
	await expect(dialog.getByRole("status")).toHaveText("Saved");
	expect(await saved(page)).toBe("off");
});

test("On saves on when the browser already allows notifications", async ({
	page,
	context,
}) => {
	await context.grantPermissions(["notifications"], { origin: WEB_ORIGIN });
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	const dialog = await openSettings(page);
	const group = dialog.getByRole("group", { name: "Desktop notifications" });
	await group.getByRole("radio", { name: "On" }).check();
	await expect(dialog.getByRole("status")).toHaveText("Saved");
	expect(await saved(page)).toBe("on");
});

test("On asks the browser once and saves off when the answer is no", async ({
	page,
	context,
}) => {
	await undecidedBrowser(page, "denied");
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	const dialog = await openSettings(page);
	expect(await timesAsked(page)).toBe(0);
	await dialog
		.getByRole("group", { name: "Desktop notifications" })
		.getByRole("radio", { name: "On" })
		.click();
	await expect(dialog.getByRole("status")).toHaveText("Saved");
	expect(await timesAsked(page)).toBe(1);
	expect(await saved(page)).toBe("off");
});

test("a blocked browser gets a note that says what to do", async ({
	page,
	context,
}) => {
	await context.clearPermissions();
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	const permission = await page.evaluate(() => Notification.permission);
	test.skip(permission !== "denied", "this browser starts at ask, not blocked");
	const dialog = await openSettings(page);
	await expect(dialog.getByTestId("settings-notifications-blocked")).toContainText(
		"blocked notifications",
	);
});

test("search finds the setting", async ({ page, context }) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	const dialog = await openSettings(page);
	await dialog.getByLabel("Search").fill("desktop");
	await dialog
		.getByRole("button", { name: "Desktop notifications", exact: true })
		.click();
	await expect(
		dialog
			.getByRole("group", { name: "Desktop notifications" })
			.getByRole("radio")
			.first(),
	).toBeFocused();
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`the notifications setting has no axe violations in ${colorScheme}`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const student = await createStudent(context);
		await page.goto(workspacePath(student.workspaceId));
		await openSettings(page);
		await expect(
			page.getByRole("group", { name: "Desktop notifications" }),
		).toBeVisible();
		await expectNoViolations(page, "[data-testid=dialog-editor-settings]");
	});
}

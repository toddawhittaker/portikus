import { expect, type Page, test } from "@playwright/test";
import {
	createStudent,
	loginAs,
	query,
	settledAxe,
	toast,
	WCAG_TAGS,
	workspacePath,
} from "./helpers";

/**
 * Keep running until (#955, Epic 28 ruling R1): the student holds the
 * workspace up from the workspace dialog, sees when the hold ends in their
 * own timezone, and ends it early; the administrator's cap bounds the
 * choice. The worker does not run here, so only the API and the pages are
 * checked. The cap is one settings row, so these tests run serially.
 */
test.describe.configure({ mode: "serial" });

const ZONE = "Asia/Tokyo";

async function expectNoViolations(page: Page) {
	const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

async function setCap(hours: number): Promise<void> {
	await query("update settings set keep_running_max_hours = $1", [hours]);
}

async function holdUntil(workspaceId: string): Promise<Date | null> {
	const [row] = await query<{ keep_running_until: Date | null }>(
		"select keep_running_until from workspaces where id = $1",
		[workspaceId],
	);
	return row?.keep_running_until ?? null;
}

/** "Thu 11:30 PM" in the student's zone, as the page writes it. */
function shown(at: Date): string {
	return at.toLocaleString("en-US", {
		weekday: "short",
		hour: "numeric",
		minute: "2-digit",
		timeZone: ZONE,
	});
}

async function openWorkspaceDialog(page: Page, workspaceId: string) {
	await page.goto(workspacePath(workspaceId));
	await expect(page.getByTestId("workspace-state")).toHaveText("Running", {
		timeout: 15_000,
	});
	await page.getByTestId("workspace-status").click();
	const dialog = page.getByTestId("dialog-workspace-status");
	await expect(dialog).toBeVisible();
	return dialog;
}

test.beforeAll(async () => {
	await setCap(12);
});

test.afterAll(async () => {
	await setCap(12);
});

for (const scheme of ["light", "dark"] as const) {
	test(`a student keeps the workspace running, sees the end in their zone, and ends it early (${scheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const student = await createStudent(context);
		await query("update users set editor_settings = $2 where id = $1", [
			student.userId,
			JSON.stringify({ timezone: ZONE }),
		]);
		const dialog = await openWorkspaceDialog(page, student.workspaceId);
		const section = dialog.getByRole("region", { name: "Keep running" });
		await expect(section).toBeVisible();
		await expectNoViolations(page);

		// The button names its result: the end time, in the student's zone.
		const set = section.getByRole("button", { name: /^Keep running until / });
		const offered = Date.now() + 8 * 3_600_000;
		await expect(set).toHaveText(
			new RegExp(
				`^Keep running until (${shown(new Date(offered))}|${shown(new Date(offered - 60_000))})$`,
			),
		);
		await set.click();
		const status = section.getByTestId("keep-running-status");
		await expect(status).toBeVisible({ timeout: 15_000 });
		const until = await holdUntil(student.workspaceId);
		expect(until).not.toBeNull();
		const ahead = (until as Date).getTime() - Date.now();
		// Eight hours is picked first.
		expect(ahead).toBeGreaterThan(7.9 * 3_600_000);
		expect(ahead).toBeLessThanOrEqual(8 * 3_600_000);
		await expect(status).toContainText(`Kept running until ${shown(until as Date)}`);
		// Setting a hold is announced, since focus stays on the button.
		const announce = page
			.getByRole("status")
			.filter({ hasText: /^Kept running until / });
		await expect(announce).toHaveText(`Kept running until ${shown(until as Date)}.`);
		await expect(page.getByTestId("keep-running-indicator")).toContainText(
			`Kept running until ${shown(until as Date)}`,
		);
		await expectNoViolations(page);

		await section.getByRole("button", { name: "Don't keep running" }).click();
		await expect(page.getByTestId("keep-running-announce")).toHaveText(
			"Keep running ended.",
		);
		// The pressed button is gone; focus waits on the button that sets a new hold.
		await expect(set).toBeFocused();
		await expect(status).toBeHidden({ timeout: 15_000 });
		await expect(page.getByTestId("keep-running-indicator")).toBeHidden();
		expect(await holdUntil(student.workspaceId)).toBeNull();
		const actions = await query<{ action: string }>(
			"select action from audit_events where target = $1 and action like 'workspace.keep_running%' order by id",
			[student.workspaceId],
		);
		expect(actions.map((row) => row.action)).toEqual([
			"workspace.keep_running_set",
			"workspace.keep_running_ended",
		]);
	});
}

for (const scheme of ["light", "dark"] as const) {
	test(`an administrator sees a student's hold in the guard summary, and a cap of 0 reads as off (${scheme})`, async ({
		page,
		browser,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const studentContext = await browser.newContext();
		const student = await createStudent(studentContext);
		await studentContext.close();
		await query(
			"update workspaces set keep_running_until = now() + interval '3 hours' where id = $1",
			[student.workspaceId],
		);
		await loginAs(page, "carol");
		await page.goto(`/admin?tab=workspaces&user=${student.userId}`);
		const limits = page.getByTestId("detail-guard-limits");
		await expect(limits).toContainText("Kept running by its owner until", {
			timeout: 15_000,
		});
		await expectNoViolations(page);

		await setCap(0);
		await page.reload();
		await page.getByTestId("detail-guard-edit").click();
		const dialog = page.getByTestId("guard-dialog");
		await expect(dialog.getByText("Site setting: 0 (off)")).toBeVisible();
		await expectNoViolations(page);
		await setCap(12);
	});
}

test("an administrator's cap bounds the choice, and 0 turns it off", async ({
	page,
	browser,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await loginAs(page, "carol");
	await page.goto("/admin?tab=settings");
	const stop = page.getByRole("region", { name: "When workspaces stop" });
	const cap = stop.getByLabel("Longest keep running (hours)", { exact: true });
	await expect(cap).toHaveValue("12", { timeout: 15_000 });
	await cap.fill("2");
	await stop.getByTestId("keep-running-max-save").click();
	await expect(toast(page, "Keep running saved")).toBeVisible();
	await expectNoViolations(page);

	const studentContext = await browser.newContext();
	const student = await createStudent(studentContext);
	const studentPage = await studentContext.newPage();
	const dialog = await openWorkspaceDialog(studentPage, student.workspaceId);
	await dialog.locator("#keep-running-hours").click();
	const options = studentPage.getByRole("option");
	await expect(options).toHaveText(["1 hour", "2 hours"]);
	await studentPage.keyboard.press("Escape");

	// The API refuses anything past the cap, whatever the page offers.
	const refused = await studentPage.evaluate(async (id) => {
		const response = await fetch(`/workspaces/${id}/keep-running`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				until: new Date(Date.now() + 3 * 3_600_000).toISOString(),
			}),
		});
		return response.status;
	}, student.workspaceId);
	expect(refused).toBe(400);
	expect(await holdUntil(student.workspaceId)).toBeNull();

	await cap.fill("0");
	await stop.getByTestId("keep-running-max-save").click();
	// The first save's toast can still be up, so two match; the newest is last.
	await expect(toast(page, "Keep running saved").last()).toBeVisible();
	await studentPage.reload();
	await expect(studentPage.getByTestId("workspace-state")).toHaveText("Running", {
		timeout: 15_000,
	});
	await studentPage.getByTestId("workspace-status").click();
	await expect(studentPage.getByTestId("dialog-workspace-status")).toBeVisible();
	await expect(studentPage.getByRole("region", { name: "Keep running" })).toHaveCount(
		0,
	);
	await studentContext.close();
});

test("ending a hold under a cap of 0 announces it and moves focus to the dialog heading", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await query(
		"update workspaces set keep_running_until = now() + interval '3 hours' where id = $1",
		[student.workspaceId],
	);
	await setCap(0);
	try {
		const dialog = await openWorkspaceDialog(page, student.workspaceId);
		const section = dialog.getByRole("region", { name: "Keep running" });
		await expect(
			section.getByRole("button", { name: /^Keep running until / }),
		).toHaveCount(0);
		await section.getByRole("button", { name: "Don't keep running" }).click();
		await expect(section).toHaveCount(0, { timeout: 15_000 });
		await expect(page.getByTestId("keep-running-announce")).toHaveText(
			"Keep running ended.",
		);
		await expect(dialog.getByRole("heading", { name: "Your workspace" })).toBeFocused();
		await expectNoViolations(page);
	} finally {
		await setCap(12);
	}
});

/** Fails when the element's text runs past its box or past the dialog. */
async function expectUnclipped(page: Page, testId: string) {
	const fits = await page.getByTestId(testId).evaluate((element) => {
		const box = element.getBoundingClientRect();
		const dialog = element.closest('[role="dialog"]')?.getBoundingClientRect();
		return (
			element.scrollWidth <= element.clientWidth &&
			element.scrollHeight <= element.clientHeight + 1 &&
			!!dialog &&
			box.left >= dialog.left &&
			box.right <= dialog.right + 0.5
		);
	});
	expect(fits).toBe(true);
}

for (const scheme of ["light", "dark"] as const) {
	test(`a week-long Keep running button wraps at 320 px and at 200% text (${scheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		await setCap(168);
		try {
			const student = await createStudent(context);
			await page.setViewportSize({ width: 320, height: 720 });
			const dialog = await openWorkspaceDialog(page, student.workspaceId);
			await dialog.locator("#keep-running-hours").click();
			await page.getByRole("option", { name: "168 hours" }).click();
			const set = dialog.getByTestId("keep-running-set");
			// A week ahead names its date, the longest label the button gets.
			await expect(set).toHaveText(/^Keep running until \w{3}, \w{3} \d{1,2}, /);
			await set.scrollIntoViewIfNeeded();
			await expectUnclipped(page, "keep-running-set");
			await page.screenshot({ path: `screenshots/keep-running-320-${scheme}.png` });
			await expectNoViolations(page);

			// Text at 200% (the control font tokens doubled) in a 640 px window.
			await page.setViewportSize({ width: 640, height: 720 });
			await page.addStyleTag({
				content:
					"html:root { --density-comfortable-font: 28px !important; --density-compact-font: 26px !important; }",
			});
			await expect(set).toHaveCSS("font-size", "28px");
			await set.scrollIntoViewIfNeeded();
			await expectUnclipped(page, "keep-running-set");
			await page.screenshot({ path: `screenshots/keep-running-text200-${scheme}.png` });
		} finally {
			await setCap(12);
		}
	});
}

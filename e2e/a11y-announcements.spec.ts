/**
 * The workspace page's status regions (SPEC.md section 25.8): each is always
 * mounted and stays outside the aria-hidden a modal dialog puts on the page,
 * so a message that arrives while Settings is open is still heard; and no
 * live region carries a time that ticks each minute.
 */
import { expect, type Page, test } from "@playwright/test";
import { createStudent, expectNoViolations, query, workspacePath } from "./helpers";

const REGIONS = [
	"throttle-announce",
	"memory-announce",
	"reinstall-announce",
	"disconnect-announce",
	"storage-warning-announce",
	"memory-warning-announce",
	"state-unverified-announce",
	"workspace-state-announce",
	"screen-reader-status",
];

test("status regions stay audible while Settings is open", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("workspace-status")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await expect(page.getByTestId("dialog-editor-settings")).toBeVisible();
	// The dialog does hide the page behind it, so the check below means something.
	await expect(page.getByRole("button", { name: /screen-reader mode/ })).toHaveCount(0);

	for (const id of REGIONS) {
		const hidden = await page
			.getByTestId(id)
			.evaluate((node) => node.closest('[aria-hidden="true"]') !== null);
		expect(hidden, `${id} is under aria-hidden`).toBe(false);
	}

	// Keeping the regions audible must not leave a control around them
	// exposed, including one that loads after the dialog opened.
	await expect.poll(() => buttonsOutsideDialog(page)).toEqual([]);
});

test("a notice that mounts while Settings is open is neither exposed nor reachable by Tab", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("workspace-status")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	const dialog = page.getByTestId("dialog-editor-settings");
	await expect(dialog).toBeVisible();

	await query(
		"update workspaces set cpu_throttle = $2, updated_at = now() where id = $1",
		[
			student.workspaceId,
			JSON.stringify({
				at: new Date().toISOString(),
				averagePercent: 97,
				thresholdPercent: 80,
				windowMinutes: 30,
				sharePercent: 25,
				allowance: "100ms/100ms",
			}),
		],
	);
	const notice = page.getByTestId("throttle-notice");
	await expect(notice).toBeAttached({ timeout: 15_000 });
	// Its announcement is still heard.
	await expect(page.getByTestId("throttle-announce")).not.toHaveText("");
	await expect.poll(() => buttonsOutsideDialog(page)).toEqual([]);
	await expect(notice.getByRole("button")).toHaveCount(0);

	// Tab goes round the dialog and never reaches the notice.
	for (let press = 0; press < 40; press += 1) {
		await page.keyboard.press("Tab");
		const inside = await page.evaluate(
			() => document.activeElement?.closest('[role="dialog"]') !== null,
		);
		expect(inside, `Tab ${press + 1} left the dialog`).toBe(true);
	}
});

/** Each button a screen reader can reach outside the open dialog. */
function buttonsOutsideDialog(page: Page): Promise<(string | null)[]> {
	return page
		.getByRole("button")
		.evaluateAll((buttons) =>
			buttons
				.filter((button) => !button.closest('[role="dialog"]'))
				.map((button) => button.getAttribute("data-testid") ?? button.textContent),
		);
}

test("the disconnect stop is announced once, with a fixed time, from an always-mounted region", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("workspace-status")).toBeVisible({ timeout: 15_000 });
	const announce = page.getByTestId("disconnect-announce");
	await expect(announce).toHaveText("");

	await query(
		"update workspaces set shutdown_deadline = now() + interval '10 minutes', updated_at = now() where id = $1",
		[student.workspaceId],
	);
	const notice = page.getByTestId("disconnect-notice");
	await expect(notice).toBeVisible({ timeout: 15_000 });
	await expect(announce).toHaveText(
		/^You're disconnected\. Your workspace will stop at \d{1,2}:\d{2}(\s?[AP]M)? unless a window reconnects\.$/,
	);

	// The visible notice counts the minutes down, so it is not itself a live region.
	await expect(notice).not.toHaveAttribute("role", /.+/);
	await expect(notice).not.toHaveAttribute("aria-live", /.+/);
	const live = await page
		.locator('[role="status"], [role="alert"], [aria-live]')
		.allTextContents();
	expect(live.filter((text) => /\d+ minutes?\b/.test(text))).toEqual([]);
});

test("the inline Still working? notice is not a live region", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("workspace-status")).toBeVisible({ timeout: 15_000 });
	await query(
		`update workspaces
		    set idle_stop_at = now() + interval '5 minutes',
		        last_activity_at = now() - interval '10 minutes',
		        updated_at = now()
		  where id = $1`,
		[student.workspaceId],
	);
	const notice = page.getByTestId("idle-notice");
	await expect(notice).toBeVisible({ timeout: 15_000 });
	// Heard through the focused Keep working button and its description instead.
	await expect(notice.getByRole("button", { name: "Keep working" })).toBeFocused();
	await expect(notice).not.toHaveAttribute("role", /.+/);
	await expect(notice).not.toHaveAttribute("aria-live", /.+/);
});

for (const scheme of ["light", "dark"] as const) {
	test(`the disconnect notice, and Settings over it, have no automatic violations (${scheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const student = await createStudent(context);
		await query(
			"update workspaces set shutdown_deadline = now() + interval '10 minutes', updated_at = now() where id = $1",
			[student.workspaceId],
		);
		await page.goto(workspacePath(student.workspaceId));
		await expect(page.getByTestId("disconnect-notice")).toBeVisible({
			timeout: 15_000,
		});
		await page.screenshot({ path: `screenshots/disconnect-notice-${scheme}.png` });
		await expectNoViolations(page);

		await page.getByTestId("me").click();
		await page.getByRole("menuitem", { name: "Settings" }).click();
		await expect(page.getByTestId("dialog-editor-settings")).toBeVisible();
		await expectNoViolations(page);
	});
}

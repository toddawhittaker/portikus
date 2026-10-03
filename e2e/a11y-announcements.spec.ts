/**
 * The workspace page's status regions (SPEC.md section 25.8): each is always
 * mounted and stays outside the aria-hidden a modal dialog puts on the page,
 * so a message that arrives while Settings is open is still heard; and no
 * live region carries a time that ticks each minute.
 */
import { expect, test } from "@playwright/test";
import { createStudent, expectNoViolations, query, workspacePath } from "./helpers";

const REGIONS = [
	"throttle-announce",
	"memory-announce",
	"reinstall-announce",
	"disconnect-announce",
	"storage-warning-announce",
	"memory-warning-announce",
	"state-unverified-announce",
	"workspace-state",
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
});

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

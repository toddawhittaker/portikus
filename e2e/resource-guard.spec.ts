import { expect, test } from "@playwright/test";
import {
	createStudent,
	loginAs,
	openAdmin,
	openDetail,
	query,
	setWorkspaceState,
	studentIn,
	toast,
	workspacePath,
} from "./helpers";

/**
 * The resource guard as the student and the administrator see it (ADR 0032,
 * SPEC.md §20.1). The worker does not run here, so each test writes the
 * throttle row the worker would, and checks what the pages make of it.
 */

async function throttle(workspaceId: string): Promise<void> {
	await query(
		"update workspaces set cpu_throttle = $2, updated_at = now() where id = $1",
		[
			workspaceId,
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
}

test("an administrator sets a workspace override and sees it", async ({
	page,
	browser,
}) => {
	const student = await studentIn(browser, "Guard");
	await openAdmin(page);
	const panel = await openDetail(page, student.name, "Resource guard");

	await panel
		.getByRole("button", { name: `Guard settings for ${student.name}'s workspace` })
		.click();
	const dialog = page.getByRole("dialog", {
		name: `Resource guard for ${student.name}'s workspace`,
	});
	await dialog.getByLabel("CPU threshold (%)").fill("95");
	await dialog.getByLabel("Idle stop (minutes)").fill("0");
	await dialog.getByTestId("guard-save").click();
	await expect(toast(page, "Guard settings saved")).toBeVisible();

	const limits = panel.getByTestId("detail-guard-limits");
	await expect(limits).toContainText("CPU above 95% (override)");
	await expect(limits).toContainText("Never stopped for inactivity (override).");
	const [row] = await query<{ guard_config: unknown }>(
		"select guard_config from workspaces where id = $1",
		[student.workspaceId],
	);
	expect(row?.guard_config).toEqual({ cpuThresholdPercent: 95, idleStopMinutes: 0 });
});

test("a throttle shows the student notice and the admin tag; Lift throttle clears both", async ({
	page,
	browser,
}) => {
	// The student keeps a page of their own open beside carol's.
	const studentContext = await browser.newContext();
	const student = await createStudent(studentContext);
	const name = `Guard ${student.userId.slice(0, 8)}`;
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);
	await throttle(student.workspaceId);
	const studentPage = await studentContext.newPage();
	await studentPage.goto(workspacePath(student.workspaceId));
	const notice = studentPage.getByTestId("throttle-notice");
	await expect(notice).toBeVisible({ timeout: 15_000 });
	await expect(notice).toContainText(
		"It kept its CPUs more than 80% busy for 30 minutes, so it now gets 25% of its usual CPU.",
	);
	// The words reach a screen reader through the always-mounted status region.
	await expect(studentPage.getByTestId("throttle-announce")).toContainText(
		"Your workspace has been slowed down.",
	);

	await openAdmin(page);
	await page.getByTestId("admin-filter-text").fill(name);
	const row = page.getByTestId(`account-row-${student.userId}`);
	await expect(row.getByText("Throttled", { exact: true })).toBeVisible();

	const panel = await openDetail(page, name, "Resource guard");
	await panel
		.getByRole("button", { name: `Lift throttle on ${name}'s workspace` })
		.click();
	await expect(toast(page, "Throttle lifted")).toBeVisible();
	await expect(row.getByText("Throttled", { exact: true })).toHaveCount(0);
	await expect(panel.getByTestId("detail-guard-cpu")).toHaveText("Normal");
	await expect(notice).toHaveCount(0, { timeout: 15_000 });

	const [after] = await query<{ cpu_throttle: unknown }>(
		"select cpu_throttle from workspaces where id = $1",
		[student.workspaceId],
	);
	expect(after?.cpu_throttle).toBeNull();
	await studentContext.close();
});

test("the Health tab lists a throttled workspace and links to its panel", async ({
	page,
	browser,
}) => {
	const student = await studentIn(browser, "Guard");
	await throttle(student.workspaceId);

	await loginAs(page, "carol");
	await page.goto("/admin?tab=health");
	const list = page.getByTestId("health-guard");
	await expect(list).toBeVisible({ timeout: 15_000 });
	await list.getByRole("link", { name: student.name }).click();
	await expect(page.getByRole("region", { name: student.name })).toBeVisible();
});

test("the slowed-down notice's Restart workspace… opens Restart's confirmation", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await throttle(student.workspaceId);
	await page.goto(workspacePath(student.workspaceId));
	const notice = page.getByTestId("throttle-notice");
	await expect(notice).toBeVisible({ timeout: 15_000 });

	await notice.getByRole("button", { name: "Restart workspace…" }).click();
	const confirm = page.getByTestId("dialog-workspace-restart");
	await expect(confirm).toBeVisible();
	// Cancel leaves the student in the workspace dialog, where Restart lives.
	await confirm.getByRole("button", { name: "Cancel" }).click();
	await expect(confirm).toHaveCount(0);
	await expect(page.getByTestId("dialog-workspace-status")).toBeVisible();
});

test("Restart from the throttle notice waits while the state settles, then restarts (#707)", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await throttle(student.workspaceId);
	await page.goto(workspacePath(student.workspaceId));
	await page.getByTestId("throttle-restart").click();
	const confirmDialog = page.getByTestId("dialog-workspace-restart");
	await expect(confirmDialog).toBeVisible({ timeout: 15_000 });

	// The workspace starts moving under the open confirmation.
	await setWorkspaceState(student.workspaceId, "starting");
	const confirm = confirmDialog.getByTestId("dialog-confirm");
	await expect(confirm).toBeDisabled({ timeout: 15_000 });
	await expect(confirmDialog).toContainText(
		"Starting your workspace. You can restart once it has finished.",
	);

	await setWorkspaceState(student.workspaceId, "running");
	await expect(confirm).toBeEnabled({ timeout: 15_000 });
	const restart = page.waitForResponse(
		(response) =>
			response.url().endsWith(`/workspaces/${student.workspaceId}/restart`) &&
			response.request().method() === "POST",
	);
	await confirm.click();
	expect((await restart).ok()).toBe(true);
	await expect(confirmDialog).toHaveCount(0);
});

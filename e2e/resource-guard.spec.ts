import { type Browser, expect, type Page, test } from "@playwright/test";
import {
	createStudent,
	loginAs,
	query,
	type TestStudent,
	toast,
	workspacePath,
} from "./helpers";

/**
 * The resource guard as the student and the administrator see it (ADR 0032,
 * SPEC.md §20.1). The worker does not run here, so each test writes the
 * throttle row the worker would, and checks what the pages make of it.
 */

/** Carol, the mock provider's administrator, on the Users tab. */
async function openAdmin(page: Page): Promise<void> {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
}

/** A student with a workspace, made in a context of its own so carol keeps her session. */
async function studentIn(browser: Browser): Promise<TestStudent & { name: string }> {
	const context = await browser.newContext();
	const student = await createStudent(context);
	await context.close();
	const name = `Guard ${student.userId.slice(0, 8)}`;
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);
	return { ...student, name };
}

async function openDetail(page: Page, name: string) {
	await page.getByTestId("admin-filter-text").fill(name);
	await page.getByRole("button", { name: `Show details for ${name}` }).click();
	const panel = page.getByRole("region", { name });
	await expect(panel.getByRole("region", { name: "Resource guard" })).toBeVisible();
	return panel;
}

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
	const student = await studentIn(browser);
	await openAdmin(page);
	const panel = await openDetail(page, student.name);

	await panel
		.getByRole("button", { name: `Change overrides for ${student.name}'s workspace` })
		.click();
	const dialog = page.getByRole("dialog", { name: "Resource guard overrides" });
	await dialog.getByLabel("CPU threshold (%)").fill("95");
	await dialog.getByLabel("Idle stop (minutes)").fill("0");
	await dialog.getByTestId("guard-save").click();
	await expect(toast(page, "Overrides saved")).toBeVisible();

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

	const panel = await openDetail(page, name);
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
	const student = await studentIn(browser);
	await throttle(student.workspaceId);

	await loginAs(page, "carol");
	await page.goto("/admin?tab=health");
	const list = page.getByTestId("health-guard");
	await expect(list).toBeVisible({ timeout: 15_000 });
	await list.getByRole("link", { name: student.name }).click();
	await expect(page.getByRole("region", { name: student.name })).toBeVisible();
});

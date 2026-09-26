/**
 * The student's side of the resource guard (ADR 0032; docs/EPIC-21.md rulings
 * 5, 7, 22 to 24): each notice opens Monitor sorted by what it is about, the
 * status bar warns about memory from 85%, and a lifted throttle is told by a
 * toast. The worker does not run here, so each test writes the rows it would.
 */
import { expect, type Page, test } from "@playwright/test";
import { createStudent, query, toast, workspacePath } from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

const GIB = 1024 ** 3;

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

async function flagMemory(workspaceId: string): Promise<void> {
	await query(
		"update workspaces set memory_flag = $2, updated_at = now() where id = $1",
		[
			workspaceId,
			JSON.stringify({
				at: new Date().toISOString(),
				averagePercent: 93,
				thresholdPercent: 90,
				windowMinutes: 10,
			}),
		],
	);
}

async function seedMemory(workspaceId: string, usedBytes: number, totalBytes: number) {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/memory`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, usedBytes, totalBytes }),
	});
	if (!response.ok)
		throw new Error(`the fake agent refused the memory: ${response.status}`);
}

async function expectMonitorSortedBy(page: Page, column: "CPU" | "Memory") {
	await expect(page.getByRole("tab", { name: "Monitor" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(page.getByRole("columnheader", { name: column })).toHaveAttribute(
		"aria-sort",
		"descending",
	);
}

test("See what's using CPU opens Monitor sorted by CPU, and the notice says when it lifts", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await throttle(student.workspaceId);
	await page.goto(workspacePath(student.workspaceId));
	const notice = page.getByTestId("throttle-notice");
	await expect(notice).toBeVisible({ timeout: 15_000 });
	// The idle-lift settings default to 5 minutes under 10% (T1).
	await expect(notice).toContainText(
		"It returns to full speed on its own after 5 minutes under 10% use.",
	);

	// Move Monitor off its default sort first, so the button's sort is what shows.
	await page.getByRole("tab", { name: "Monitor" }).click();
	await page.getByRole("button", { name: "PID", exact: true }).click();
	await page.getByRole("tab", { name: "Files" }).click();

	await notice.getByRole("button", { name: "See what's using CPU" }).click();
	await expectMonitorSortedBy(page, "CPU");
	// Focus follows the pane change.
	await expect(page.getByTestId("monitor-title")).toBeFocused();
});

test("the memory notice explains the flag and opens Monitor sorted by memory", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("workspace-state")).toHaveText("Running", {
		timeout: 15_000,
	});
	// Flagged while the page is open: the socket must bring it.
	await flagMemory(student.workspaceId);
	const notice = page.getByTestId("memory-notice");
	await expect(notice).toBeVisible();
	await expect(notice).toContainText("Your workspace has been near its memory limit");
	await expect(notice).toContainText(
		"For 10 minutes it used more than 90% of its memory. If it runs out, the biggest program is stopped.",
	);
	await expect(page.getByTestId("memory-announce")).toContainText(
		"Your workspace has been near its memory limit.",
	);

	await notice.getByRole("button", { name: "See what's using memory" }).click();
	await expectMonitorSortedBy(page, "Memory");
	await expect(page.getByTestId("monitor-title")).toBeFocused();

	await notice.getByRole("button", { name: "Dismiss the memory notice" }).click();
	await expect(notice).toHaveCount(0);
	await expect(page.getByRole("main", { name: "Work area" })).toBeFocused();
});

test("an administrator clearing the memory flag takes the notice away on an open page", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await flagMemory(student.workspaceId);
	await page.goto(workspacePath(student.workspaceId));
	const notice = page.getByTestId("memory-notice");
	await expect(notice).toBeVisible({ timeout: 15_000 });
	// The notice holds focus when it goes, so focus must land on the work area.
	await notice.getByRole("button", { name: "Dismiss the memory notice" }).focus();
	await query(
		"update workspaces set memory_flag = null, updated_at = now() where id = $1",
		[student.workspaceId],
	);
	await expect(notice).toHaveCount(0);
	await expect(page.getByRole("main", { name: "Work area" })).toBeFocused();
});

test("the status bar memory meter warns at 85% and opens Monitor sorted by memory", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedMemory(student.workspaceId, 90 * GIB, 100 * GIB);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("workspace-state")).toHaveText("Running", {
		timeout: 15_000,
	});

	// Until its first sample the status bar asks every 2 s, not every 30 s.
	const warning = page.getByTestId("memory-meter");
	await expect(warning).toHaveAttribute("data-level", "warning", { timeout: 5000 });
	await expect(warning).toHaveText("Memory90.0 GB of 100 GB");
	await expect(warning).toHaveAccessibleName(
		"Memory 90.0 GB of 100 GB, high. See what's using memory",
	);
	await expect(page.getByTestId("memory-warning-announce")).toHaveText(
		"Your workspace is using most of its memory.",
	);
	await warning.click();
	await expectMonitorSortedBy(page, "Memory");
	await expect(page.getByTestId("monitor-title")).toBeFocused();
});

test("below 85% the status bar still shows memory, in the plain tone and unannounced", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedMemory(student.workspaceId, 84 * GIB, 100 * GIB);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("workspace-state")).toHaveText("Running", {
		timeout: 15_000,
	});
	// Monitor shows the same sample, so once it is there the status bar has it too.
	await page.getByRole("tab", { name: "Monitor" }).click();
	await expect(page.getByTestId("monitor-memory")).toHaveText("84.0 GB / 100 GB");
	const meter = page.getByTestId("memory-meter");
	await expect(meter).toHaveAttribute("data-level", "ok");
	await expect(meter).toHaveAccessibleName(
		"Memory 84.0 GB of 100 GB. See what's using memory",
	);
	await expect(page.getByTestId("memory-warning-announce")).toHaveText("");
});

test("a toast says so when the throttle lifts while the page is open", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await throttle(student.workspaceId);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("throttle-notice")).toBeVisible({ timeout: 15_000 });

	// What the worker's idle lift does to the row.
	await query(
		"update workspaces set cpu_throttle = null, updated_at = now() where id = $1",
		[student.workspaceId],
	);
	await expect(toast(page, "Your workspace is back to full speed")).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByTestId("throttle-notice")).toHaveCount(0);
});

test("stopping a throttled workspace shows no back-to-full-speed toast", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await throttle(student.workspaceId);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("throttle-notice")).toBeVisible({ timeout: 15_000 });

	// What the worker does when it records a stop: the throttle goes with it.
	await query(
		"update workspaces set state = 'stopping', desired_state = 'stopped', cpu_throttle = null, updated_at = now() where id = $1",
		[student.workspaceId],
	);
	await expect(page.getByTestId("throttle-notice")).toHaveCount(0);
	await expect(page.getByTestId("workspace-state")).toHaveText("Stopping");
	await expect(toast(page, "Your workspace is back to full speed")).toHaveCount(0);
});

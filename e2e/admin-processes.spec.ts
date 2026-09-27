import {
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import {
	createStudent,
	loginAs,
	query,
	type TestStudent,
	workspacePath,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * The administrator's process list and stop (SPEC.md §20.1). The worker does
 * not run here, so each test writes the
 * snapshot the worker would once carol's Refresh has made its request row.
 * The stop goes through the fake agent, which checks it as the real one does.
 */

const MINER = {
	pid: 42,
	uid: 1000,
	name: "<b>miner</b>",
	startTicks: 500,
	cpuPercent: 99,
	residentBytes: 8192,
	protected: false,
};
const STUBBORN = {
	pid: 43,
	uid: 1000,
	name: "stubborn",
	startTicks: 600,
	cpuPercent: 50,
	residentBytes: 4_000_000_000,
	protected: false,
};
const AGENT = {
	pid: 9,
	uid: 0,
	name: "portikus-agent",
	startTicks: 10,
	cpuPercent: 0.2,
	residentBytes: 2048,
	protected: true,
};

/** A student signed in through a context of its own, so carol keeps her session. */
async function studentIn(
	browser: Browser,
): Promise<TestStudent & { name: string; context: BrowserContext }> {
	const context = await browser.newContext();
	const student = await createStudent(context);
	const name = `Procs ${student.userId.slice(0, 8)}`;
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);
	return { ...student, name, context };
}

/** The fake agent's own list, so its stop checks match the snapshot. */
async function seedAgent(workspaceId: string): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/processes`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			key: workspaceId,
			processes: [
				{ ...MINER, command: MINER.name, stoppable: true, commandLine: null },
				{
					...STUBBORN,
					command: STUBBORN.name,
					stoppable: true,
					commandLine: null,
					ignoresTerm: true,
				},
			],
		}),
	});
	if (!response.ok) throw new Error(`the fake agent refused: ${response.status}`);
}

/** Wait for Refresh's request row, then answer it as the worker would. */
async function answerRefresh(workspaceId: string): Promise<void> {
	await expect
		.poll(async () => {
			const rows = await query(
				"select 1 from workspace_process_snapshots where workspace_id = $1 and (taken_at is null or taken_at <= requested_at)",
				[workspaceId],
			);
			return rows.length;
		})
		.toBe(1);
	await query(
		"update workspace_process_snapshots set taken_at = now(), processes = $2, error = null where workspace_id = $1",
		[workspaceId, JSON.stringify([AGENT, STUBBORN, MINER])],
	);
}

async function openDetail(page: Page, name: string) {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("admin-filter-text").fill(name);
	await page.getByRole("button", { name: `Show details for ${name}` }).click();
	const panel = page.getByRole("region", { name });
	const section = panel.getByRole("region", { name: "Processes" });
	await expect(section).toBeVisible();
	return section;
}

test("an administrator reads the processes, stops one, and force-stops another", async ({
	page,
	browser,
}) => {
	const student = await studentIn(browser);
	await seedAgent(student.workspaceId);
	const section = await openDetail(page, student.name);
	await expect(section).toContainText("Press Refresh to read the processes.");

	await section
		.getByRole("button", { name: `Refresh processes in ${student.name}'s workspace` })
		.click();
	await answerRefresh(student.workspaceId);
	const table = section.getByTestId("processes-table");
	await expect(table).toBeVisible();
	await expect(section.getByTestId("processes-time")).toContainText("Read at");

	// Highest CPU first; the hostile name is shown as text.
	const rows = table.locator("tbody tr");
	await expect(rows.nth(0)).toContainText("<b>miner</b>");
	await expect(rows.nth(0)).toContainText("student");
	await expect(rows.nth(2)).toContainText("system");
	await expect(table.locator("b")).toHaveCount(0);
	await table.getByRole("button", { name: "Memory" }).click();
	await expect(rows.nth(0)).toContainText("stubborn");
	// The agent is protected: no Stop button, and the row says why.
	await expect(
		section.getByRole("button", { name: /Stop portikus-agent/ }),
	).toHaveCount(0);
	await expect(section.getByTestId(`processes-protected-${AGENT.pid}`)).toHaveText(
		"Protected: the system or Portikus needs this process, so it cannot be stopped here.",
	);
	await expect(table.getByRole("button", { name: "Memory" })).toHaveText("Memory ↓");

	await section.getByRole("button", { name: "Stop <b>miner</b> (PID 42)" }).click();
	const dialog = page.getByTestId("dialog-admin-stop-process");
	await expect(dialog).toContainText(
		"The student is told that an administrator stopped a process.",
	);
	await dialog.getByRole("button", { name: "Stop" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(section.getByTestId("process-row-42")).toHaveCount(0);
	await expect(page.locator("#detail-processes")).toBeFocused();

	await section.getByRole("button", { name: "Stop stubborn (PID 43)" }).click();
	await dialog.getByRole("button", { name: "Stop" }).click();
	await expect(dialog.getByTestId("admin-stop-status")).toHaveText(
		"stubborn is still running.",
	);
	await dialog.getByRole("button", { name: "Force stop" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(section.getByTestId("process-row-43")).toHaveCount(0);

	// The student sees the notice in their history.
	const context = student.context;
	const studentPage = await context.newPage();
	await studentPage.goto(workspacePath(student.workspaceId));
	await expect(studentPage.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });
	await studentPage.getByTestId("me").click();
	await studentPage.getByRole("menuitem", { name: "Notifications" }).click();
	// Two stops ended processes; the Stop that stubborn survived told nobody.
	await expect(
		studentPage
			.getByTestId("dialog-notifications")
			.getByTestId("notification")
			.filter({ hasText: "An administrator stopped a process in your workspace" }),
	).toHaveCount(2);
	await context.close();
});

test("a stopped workspace offers no Refresh", async ({ page, browser }) => {
	const student = await studentIn(browser);
	await query(
		"update workspaces set state = 'stopped', desired_state = 'stopped' where id = $1",
		[student.workspaceId],
	);
	const section = await openDetail(page, student.name);
	await expect(section).toContainText("The workspace is not running.");
	await expect(section.getByRole("button", { name: /Refresh processes/ })).toHaveCount(
		0,
	);
});

test("the keyboard alone reads the list and stops a process", async ({
	page,
	browser,
}) => {
	const student = await studentIn(browser);
	await seedAgent(student.workspaceId);
	const section = await openDetail(page, student.name);
	const refresh = section.getByRole("button", { name: /Refresh processes/ });
	await refresh.focus();
	await page.keyboard.press("Enter");
	await answerRefresh(student.workspaceId);
	await expect(section.getByTestId("processes-table")).toBeVisible();

	const stop = section.getByRole("button", { name: "Stop <b>miner</b> (PID 42)" });
	// Tab from Refresh through the table's buttons to the first Stop.
	for (let i = 0; i < 10; i += 1) {
		await page.keyboard.press("Tab");
		if (await stop.evaluate((el) => el === document.activeElement)) break;
	}
	await expect(stop).toBeFocused();
	await page.keyboard.press("Enter");
	const dialog = page.getByTestId("dialog-admin-stop-process");
	await expect(dialog).toBeVisible();
	// Escape cancels and returns focus to the Stop button.
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(stop).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(dialog.getByRole("button", { name: "Stop" })).toBeVisible();
	await dialog.getByRole("button", { name: "Stop" }).focus();
	await page.keyboard.press("Enter");
	await expect(section.getByTestId("process-row-42")).toHaveCount(0);
	await expect(page.locator("#detail-processes")).toBeFocused();
});

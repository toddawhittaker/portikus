/**
 * Stopping a process from Monitor (SPEC.md §18.3; docs/EPIC-21.md rulings 20
 * and 21). The fake agent reports the processes a test seeds and stops them
 * with the real agent's checks; `ignoresTerm` survives a plain stop.
 */
import { expect, type Page, test } from "@playwright/test";
import { createStudent, workspacePath } from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

async function seedProcesses(workspaceId: string, processes: unknown[]): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/processes`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, processes }),
	});
	if (!response.ok)
		throw new Error(`the fake agent refused the processes: ${response.status}`);
}

const BUSY = {
	pid: 42,
	command: "busy",
	cpuPercent: 99,
	residentBytes: 8192,
	startTicks: 500,
	stoppable: true,
	commandLine: "python3 busy.py --forever --threads 8",
};
const STUBBORN = {
	pid: 43,
	command: "stubborn",
	cpuPercent: 50,
	residentBytes: 4096,
	startTicks: 600,
	stoppable: true,
	commandLine: "bash -c trap '' TERM; while :; do :; done",
	ignoresTerm: true,
};
const TMUX = {
	pid: 12,
	command: "tmux: server",
	cpuPercent: 0.1,
	residentBytes: 2048,
	startTicks: 50,
	stoppable: false,
	commandLine: null,
};

async function openMonitor(page: Page, workspaceId: string) {
	await page.goto(workspacePath(workspaceId));
	await page.getByRole("tab", { name: "Monitor" }).click();
	await expect(page.getByTestId("monitor-process-42")).toBeVisible({ timeout: 15_000 });
}

test("a student stops one of their own processes from Monitor", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedProcesses(student.workspaceId, [BUSY, TMUX]);
	await openMonitor(page, student.workspaceId);

	// A protected process has no Stop button.
	await expect(page.getByTestId("monitor-process-12")).toBeVisible();
	await expect(page.getByRole("button", { name: /Stop tmux: server/ })).toHaveCount(0);

	await page.getByRole("button", { name: "Stop busy (PID 42)" }).click();
	const dialog = page.getByTestId("dialog-stop-process");
	await expect(dialog).toContainText("Stop busy?");
	await expect(dialog).toContainText("PID 42");
	await dialog.getByRole("button", { name: "Stop" }).click();

	await expect(dialog).toHaveCount(0);
	await expect(page.getByTestId("monitor-process-42")).toHaveCount(0);
	await expect(page.getByTestId("monitor-stop-announce")).toHaveText(
		"busy (PID 42) stopped.",
	);
	// The row and its button are gone, so focus lands on the list's heading.
	await expect(page.getByTestId("monitor-processes-heading")).toBeFocused();
	// The next sample agrees: the agent no longer reports it.
	await page.waitForTimeout(1500);
	await expect(page.getByTestId("monitor-process-42")).toHaveCount(0);
});

test("a process that ignores Stop is offered Force stop, which ends it", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedProcesses(student.workspaceId, [BUSY, STUBBORN]);
	await openMonitor(page, student.workspaceId);

	await page.getByRole("button", { name: "Stop stubborn (PID 43)" }).click();
	const dialog = page.getByTestId("dialog-stop-process");
	await dialog.getByRole("button", { name: "Stop" }).click();

	await expect(dialog.getByTestId("stop-process-status")).toHaveText(
		"stubborn is still running.",
	);
	const force = dialog.getByRole("button", { name: "Force stop" });
	await expect(force).toBeVisible();
	// Nothing is killed until the student presses Force stop.
	await expect(page.getByTestId("monitor-process-43")).toBeVisible();
	await force.click();

	await expect(dialog).toHaveCount(0);
	await expect(page.getByTestId("monitor-process-43")).toHaveCount(0);
	await expect(page.getByTestId("monitor-processes-heading")).toBeFocused();
});

test("a stop the agent refuses is explained in the dialog", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedProcesses(student.workspaceId, [BUSY]);
	await openMonitor(page, student.workspaceId);

	await page.getByRole("button", { name: "Stop busy (PID 42)" }).click();
	// The PID now belongs to a different program.
	await seedProcesses(student.workspaceId, [{ ...BUSY, startTicks: 999 }]);
	const dialog = page.getByTestId("dialog-stop-process");
	await dialog.getByRole("button", { name: "Stop" }).click();
	await expect(dialog.getByTestId("stop-process-status")).toHaveText(
		"That process ID now belongs to a different program. Refresh and try again.",
	);
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
});

test("the full command line shows below the row when asked for", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedProcesses(student.workspaceId, [BUSY, TMUX]);
	await openMonitor(page, student.workspaceId);

	await expect(
		page.getByRole("button", { name: "Show the full command for PID 12" }),
	).toHaveCount(0);
	const toggle = page.getByRole("button", { name: "Show the full command for PID 42" });
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await toggle.focus();
	await page.keyboard.press("Enter");
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(page.getByTestId("monitor-command-42")).toHaveText(BUSY.commandLine);
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("monitor-command-42")).toHaveCount(0);
});

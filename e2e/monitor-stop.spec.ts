/**
 * Stopping a process from Monitor (SPEC.md §18.3). The fake agent reports the
 * processes a test seeds and stops them
 * with the real agent's checks; `ignoresTerm` survives a plain stop.
 */
import { expect, type Page, test } from "@playwright/test";
import { createStudent, expectNoViolations, workspacePath } from "./helpers";
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

test("when a focused process exits on its own, focus moves to the Processes heading", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedProcesses(student.workspaceId, [BUSY, TMUX]);
	await openMonitor(page, student.workspaceId);
	await page.getByRole("button", { name: "Stop busy (PID 42)" }).focus();
	await seedProcesses(student.workspaceId, [TMUX]);
	await expect(page.getByTestId("monitor-process-42")).toHaveCount(0);
	await expect(page.getByTestId("monitor-processes-heading")).toBeFocused();
});

test("the rows hold still while focus is in the list, and a long name wraps", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const busy = { ...BUSY, cpuPercent: 50 };
	const quiet = { ...STUBBORN, cpuPercent: 1, ignoresTerm: false };
	await seedProcesses(student.workspaceId, [busy, quiet]);
	await openMonitor(page, student.workspaceId);
	const rows = page.locator("[data-testid^='monitor-process-']");
	await expect(rows).toHaveCount(2);
	await expect(rows.first()).toHaveAttribute("data-testid", "monitor-process-42");

	// Names are readable without hovering: the cell wraps, it does not cut off.
	await expect(page.getByTestId("monitor-process-42").locator("td").nth(3)).toHaveCSS(
		"white-space",
		"normal",
	);

	await page.getByRole("button", { name: "Stop stubborn (PID 43)" }).focus();
	await seedProcesses(student.workspaceId, [busy, { ...quiet, cpuPercent: 99 }]);
	await expect(page.getByTestId("monitor-process-43")).toContainText("99");
	await expect(rows.first()).toHaveAttribute("data-testid", "monitor-process-42");

	await page.getByTestId("monitor-processes-heading").focus();
	await expect(rows.first()).toHaveAttribute("data-testid", "monitor-process-43");
});

/** busy (42) runs a worker (44), which runs the stubborn 43 and the protected tmux 12. */
const TREE = [
	{ ...BUSY, ppid: 1 },
	{ ...BUSY, pid: 44, command: "worker", cpuPercent: 30, startTicks: 700, ppid: 42 },
	{ ...STUBBORN, ppid: 44 },
	{ ...TMUX, ppid: 44 },
];

async function openStop(page: Page, name: string) {
	await page.getByRole("button", { name: `Stop ${name}` }).click();
	return page.getByTestId("dialog-stop-process");
}

test("stopping with children shows the count and stops the tree, protected processes aside", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedProcesses(student.workspaceId, TREE);
	await openMonitor(page, student.workspaceId);

	const dialog = await openStop(page, "busy (PID 42)");
	await expect(dialog).toContainText("Stop busy?");
	await dialog
		.getByRole("checkbox", { name: "Also stop its 3 child processes" })
		.check();
	await expect(dialog).toContainText(
		"PID 42 and its 3 child processes are asked to stop.",
	);
	await expectNoViolations(page, "[data-testid='dialog-stop-process']");
	await dialog.getByRole("button", { name: "Stop", exact: true }).click();

	// The stubborn child outlives SIGTERM; nothing is killed until Force stop.
	await expect(dialog.getByTestId("stop-process-status")).toHaveText(
		"1 process is still running.",
	);
	await expect(page.getByTestId("monitor-process-43")).toBeVisible();
	await dialog.getByRole("button", { name: "Force stop" }).click();

	await expect(dialog).toHaveCount(0);
	for (const pid of [42, 43, 44]) {
		await expect(page.getByTestId(`monitor-process-${pid}`)).toHaveCount(0);
	}
	await expect(page.getByTestId("monitor-stop-announce")).toHaveText(
		"busy (PID 42) and its children stopped. One process Portikus needs was left alone.",
	);
	await expect(page.getByTestId("monitor-processes-heading")).toBeFocused();
	// The protected tmux server stays, and the next sample agrees.
	await expect(page.getByTestId("monitor-process-12")).toBeVisible();
	await page.waitForTimeout(1500);
	await expect(page.getByTestId("monitor-process-12")).toBeVisible();
	await expect(page.getByTestId("monitor-process-44")).toHaveCount(0);
});

test("a tree whose root PID was reused is refused, not stopped", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedProcesses(student.workspaceId, TREE);
	await openMonitor(page, student.workspaceId);
	const dialog = await openStop(page, "busy (PID 42)");
	await dialog
		.getByRole("checkbox", { name: "Also stop its 3 child processes" })
		.check();
	await seedProcesses(student.workspaceId, [
		{ ...TREE[0], startTicks: 999 },
		...TREE.slice(1),
	]);
	await dialog.getByRole("button", { name: "Stop", exact: true }).click();
	await expect(dialog.getByTestId("stop-process-status")).toHaveText(
		"That process ID now belongs to a different program. Refresh and try again.",
	);
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(page.getByTestId("monitor-process-44")).toBeVisible();
});

test("Lower its priority instead lowers the tree once, then says it is already lowest", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	// At nice 9, one press reaches the cap of 19.
	await seedProcesses(
		student.workspaceId,
		TREE.map((one) => ({ ...one, nice: 9 })),
	);
	await openMonitor(page, student.workspaceId);

	let dialog = await openStop(page, "busy (PID 42)");
	await dialog.getByRole("button", { name: "Lower its priority instead" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByText("Lowered the priority of busy (PID 42).")).toBeVisible();
	await expect(
		page.getByText(
			"3 processes now run after everything else. One process Portikus needs was left alone.",
		),
	).toBeVisible();
	// Every row stays; nothing was stopped, and focus is back on Stop.
	await expect(page.getByTestId("monitor-process-42")).toBeVisible();
	await expect(page.getByRole("button", { name: "Stop busy (PID 42)" })).toBeFocused();

	dialog = await openStop(page, "busy (PID 42)");
	await dialog.getByRole("button", { name: "Lower its priority instead" }).click();
	await expect(
		page.getByText(/busy \(PID 42\) already runs at the lowest priority\./),
	).toBeVisible();

	// A process without children offers no checkbox, only the priority.
	dialog = await openStop(page, "stubborn (PID 43)");
	await expect(dialog.getByRole("checkbox")).toHaveCount(0);
	await expect(
		dialog.getByRole("button", { name: "Lower its priority instead" }),
	).toBeVisible();
});

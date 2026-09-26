import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	loginAs,
	query,
	terminalIds,
	toast,
	workspacePath,
	workTabs,
} from "./helpers";

/**
 * Idle stop as the student sees it (ADR 0032, SPEC.md §6.4). The worker does
 * not run here, so each test writes the times the worker would: the idle
 * time in Settings, then `last_activity_at` moved back and `idle_stop_at`
 * five minutes on, then the stop itself.
 */
test.describe.configure({ mode: "serial" });

async function idleSetting(): Promise<number> {
	const [row] = await query<{ idle_stop_minutes: number }>(
		"select idle_stop_minutes from settings limit 1",
	);
	return row?.idle_stop_minutes ?? 60;
}

let saved = 60;

test.beforeAll(async () => {
	saved = await idleSetting();
});

test.afterAll(async () => {
	await query("update settings set idle_stop_minutes = $1", [saved]);
});

/**
 * The worker's warning after 10 idle minutes. By default the stop is five
 * minutes away, as when it is first given; a smaller `secondsLeft` stands for
 * a warning that has nearly run out.
 */
async function warn(workspaceId: string, secondsLeft = 300): Promise<void> {
	await query(
		`update workspaces
		    set idle_stop_at = now() + make_interval(secs => $2),
		        last_activity_at = now() + make_interval(secs => $2) - interval '15 minutes',
		        updated_at = now()
		  where id = $1`,
		[workspaceId, secondsLeft],
	);
}

/** Stop the workspace, as the worker or the student's Stop would. */
async function stop(workspaceId: string): Promise<void> {
	await query(
		`update workspaces
		    set desired_state = 'stopped', state = 'stopped', idle_stop_at = null,
		        updated_at = now()
		  where id = $1`,
		[workspaceId],
	);
}

async function idleStopAt(workspaceId: string): Promise<string | null> {
	const [row] = await query<{ idle_stop_at: Date | null }>(
		"select idle_stop_at from workspaces where id = $1",
		[workspaceId],
	);
	return row?.idle_stop_at ? row.idle_stop_at.toISOString() : null;
}

async function openShell(page: Page, workspaceId: string) {
	await page.goto(workspacePath(workspaceId));
	await expect(page.getByTestId("workspace-status")).toBeVisible({ timeout: 15_000 });
}

test("an administrator sets the idle time to 10 minutes in Settings", async ({
	page,
}) => {
	await loginAs(page, "carol");
	await page.goto("/admin?tab=settings");
	const input = page.getByTestId("idle-input");
	await expect(input).toHaveValue(String(saved), { timeout: 15_000 });
	await input.fill("10");
	await page.getByTestId("idle-save").click();
	await expect(toast(page, "Idle stop saved")).toBeVisible();
	expect(await idleSetting()).toBe(10);
});

test("Still working? appears, and Keep working clears it", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await openShell(page, student.workspaceId);
	await warn(student.workspaceId);

	const notice = page.getByTestId("idle-notice");
	await expect(notice).toBeVisible({ timeout: 15_000 });
	await expect(notice).toContainText("Still working?");
	await expect(notice).toContainText("nothing has happened in it for 10 minutes");
	const keep = notice.getByRole("button", { name: "Keep working" });
	await expect(keep).toBeFocused();

	await keep.click();
	await expect
		.poll(() => idleStopAt(student.workspaceId), { timeout: 15_000 })
		.toBeNull();
	await expect(notice).toHaveCount(0, { timeout: 15_000 });
});

test("unanswered, the workspace stops and the page says why", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await openShell(page, student.workspaceId);
	await warn(student.workspaceId, 30);
	await expect(page.getByTestId("idle-notice")).toBeVisible({ timeout: 15_000 });

	// The worker's idle step: stop the workspace whether or not a tab is open.
	await stop(student.workspaceId);

	await expect(page.getByTestId("idle-stopped")).toHaveText(
		"Stopped after 10 minutes without activity.",
		{ timeout: 15_000 },
	);
	await expect(page.getByTestId("idle-notice")).toHaveCount(0);
});

test("a stop well before the idle deadline does not claim idleness", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await openShell(page, student.workspaceId);
	await warn(student.workspaceId);
	await expect(page.getByTestId("idle-notice")).toBeVisible({ timeout: 15_000 });

	// The student's own Stop, or the disconnect grace period, while the notice shows.
	await stop(student.workspaceId);

	await expect(page.getByTestId("workspace-progress")).toHaveAttribute(
		"data-phase",
		"stopped",
		{ timeout: 15_000 },
	);
	await expect(page.getByTestId("idle-stopped")).toHaveCount(0);
});

test("Keep working hands the keyboard back to the terminal", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Idle Focus" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-terminal").click();
	const [id] = await terminalIds(student.workspaceId, project.id);
	if (!id) throw new Error("the terminal row was not created");
	await expectConnected(page, id);
	const terminal = page.locator(
		`[data-testid="terminal-pane-${id}"] .xterm-helper-textarea`,
	);
	await expect(terminal).toBeFocused();

	await warn(student.workspaceId);
	const keep = page.getByTestId("idle-keep-working");
	await expect(keep).toBeFocused({ timeout: 15_000 });
	await page.keyboard.press("Enter");
	// Opening the terminal wrote activity under a minute ago, so the API skips
	// this write (once a minute per workspace); clear the warning as it would.
	await query(
		"update workspaces set idle_stop_at = null, updated_at = now() where id = $1",
		[student.workspaceId],
	);

	await expect(page.getByTestId("idle-notice")).toHaveCount(0, { timeout: 15_000 });
	await expect(terminal).toBeFocused();
});

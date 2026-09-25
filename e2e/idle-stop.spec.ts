import { expect, type Page, test } from "@playwright/test";
import { createStudent, loginAs, query, toast, workspacePath } from "./helpers";

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

/** The worker's warning: idle for 10 minutes, stopping 5 minutes from now. */
async function warn(workspaceId: string): Promise<void> {
	await query(
		`update workspaces
		    set last_activity_at = now() - interval '10 minutes',
		        idle_stop_at = now() + interval '5 minutes',
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
	await warn(student.workspaceId);
	await expect(page.getByTestId("idle-notice")).toBeVisible({ timeout: 15_000 });

	// The worker's idle step: stop the workspace whether or not a tab is open.
	await query(
		`update workspaces
		    set desired_state = 'stopped', state = 'stopped', idle_stop_at = null,
		        updated_at = now()
		  where id = $1`,
		[student.workspaceId],
	);

	await expect(page.getByTestId("idle-stopped")).toHaveText(
		"Stopped after 10 minutes without activity.",
		{ timeout: 15_000 },
	);
	await expect(page.getByTestId("idle-notice")).toHaveCount(0);
});

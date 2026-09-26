import { expect, test } from "@playwright/test";
import { createStudent, query, workspacePath } from "./helpers";

/**
 * Stopping, starting and restarting from the workspace dialog (SPEC.md §6.2).
 * The worker does not run here, so the test reads the desired state the API
 * wrote and moves the workspace row itself.
 */

async function desiredState(workspaceId: string): Promise<string> {
	const rows = await query<{ desired_state: string }>(
		"select desired_state from workspaces where id = $1",
		[workspaceId],
	);
	return rows[0]?.desired_state ?? "";
}

test("stopping asks to confirm, then sets the desired state to stopped", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));

	await page.getByTestId("workspace-status").click();
	await expect(page.getByTestId("dialog-workspace-status")).toBeVisible();
	await page.getByTestId("workspace-stop").click();

	const confirm = page.getByTestId("dialog-workspace-stop");
	await expect(confirm).toContainText("Your files are kept");
	await confirm.getByRole("button", { name: "Stop workspace" }).click();

	await expect
		.poll(() => desiredState(student.workspaceId), { timeout: 15_000 })
		.toBe("stopped");

	// The dialog stays open and the presence socket reports the transition.
	await expect(page.getByTestId("dialog-workspace-status")).toBeVisible();
	await expect(page.getByTestId("workspace-transition")).toHaveText(
		"Stopping your workspace.",
		{ timeout: 15_000 },
	);
	await expect(page.getByTestId("workspace-stop")).toBeDisabled();
});

test("a stopped workspace offers Start, which sets the desired state to running", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await page.getByTestId("workspace-status").click();
	await expect(page.getByTestId("dialog-workspace-status")).toBeVisible();

	// Opening the page asks for a running workspace (SPEC.md §6.3), so a
	// stopped one with the dialog open is what a stop request leaves behind.
	await query(
		"update workspaces set state = 'stopped', desired_state = 'stopped', updated_at = now() where id = $1",
		[student.workspaceId],
	);

	await expect(page.getByTestId("workspace-start")).toBeEnabled({ timeout: 15_000 });
	await expect(page.getByTestId("workspace-stop")).toHaveCount(0);
	await page.getByTestId("workspace-start").click();

	await expect
		.poll(() => desiredState(student.workspaceId), { timeout: 15_000 })
		.toBe("running");
});

test("the dialog fits a narrow window, fingerprint and all", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await query("update workspaces set image_version = $2 where id = $1", [
		student.workspaceId,
		"b".repeat(64),
	]);

	await page.setViewportSize({ width: 360, height: 720 });
	await page.goto(workspacePath(student.workspaceId));
	await page.getByTestId("workspace-status").click();

	const dialog = page.getByTestId("dialog-workspace-status");
	await expect(dialog).toBeVisible();
	// Measure with Technical details open, since its values are the widest.
	const summary = dialog.getByText("Technical details");
	await summary.click();
	await expect(page.getByTestId("workspace-status-image")).toBeVisible();
	// Keyboard focus on the summary shows the platform focus ring.
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Tab");
	await expect(summary).toBeFocused();
	await expect(summary).toHaveCSS("outline-style", "solid");
	await expect(summary).toHaveCSS("outline-width", "2px");
	const overflows = await dialog.evaluate(
		(node) => node.scrollWidth > node.clientWidth,
	);
	expect(overflows).toBe(false);

	await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
	await expect(page.getByTestId("workspace-status-image")).toHaveText(
		`${"b".repeat(12)}…`,
	);
});

test("closing the dialog on a stopped workspace shows a Start button, not a spinner", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await page.getByTestId("workspace-status").click();
	await expect(page.getByTestId("dialog-workspace-status")).toBeVisible();

	await query(
		"update workspaces set state = 'stopped', desired_state = 'stopped', updated_at = now() where id = $1",
		[student.workspaceId],
	);
	await expect(page.getByTestId("workspace-start")).toBeEnabled({ timeout: 15_000 });

	// Clicking outside the dialog closes it; what is behind must not pretend
	// the workspace is starting (issue #230).
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("dialog-workspace-status")).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Your workspace is stopped" }),
	).toBeVisible();

	await page.getByTestId("workspace-resume").click();
	await expect
		.poll(() => desiredState(student.workspaceId), { timeout: 15_000 })
		.toBe("running");
	// The Start button is gone; focus lands on the heading, not the page body.
	await expect(page.locator("#progress-title")).toBeFocused();
});

test("secondary buttons in the workspace dialog show their border", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));

	await page.getByTestId("workspace-status").click();
	const restart = page
		.getByTestId("dialog-workspace-status")
		.getByRole("button", { name: "Restart workspace" });
	await expect(restart).toBeVisible();
	const border = await restart.evaluate((el) => getComputedStyle(el).borderTopColor);
	expect(border).not.toBe("rgba(0, 0, 0, 0)");
});

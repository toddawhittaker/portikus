/**
 * Reset Docker from the student's workspace dialog (SPEC.md §16.4) and the
 * rebuild note (SPEC.md §17.3). The worker does not run here, so the test
 * reads the pending operation the API wrote.
 */
import { expect, test } from "@playwright/test";
import { createStudent, query, workspacePath } from "./helpers";

async function pendingOperation(workspaceId: string): Promise<string | null> {
	const rows = await query<{ pending_operation: string | null }>(
		"select pending_operation from workspaces where id = $1",
		[workspaceId],
	);
	return rows[0]?.pending_operation ?? null;
}

test("Reset Docker lists what is lost and kept, then shows the pending label", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));

	await page.getByTestId("workspace-status").click();
	const status = page.getByTestId("dialog-workspace-status");
	await expect(status).toBeVisible();
	await status.getByRole("button", { name: "Reset Docker…" }).click();

	const confirm = page.getByTestId("dialog-reset-docker");
	for (const lost of ["Docker images", "containers", "volumes", "build cache"]) {
		await expect(confirm).toContainText(lost);
	}
	for (const kept of ["your projects", "your home folder", "recovery points"]) {
		await expect(confirm).toContainText(kept);
	}
	await confirm.getByRole("button", { name: "Reset Docker", exact: true }).click();

	await expect
		.poll(() => pendingOperation(student.workspaceId), { timeout: 15_000 })
		.toBe("reset-docker");
	await expect(page.getByTestId("workspace-state")).toHaveText("Resetting Docker…", {
		timeout: 15_000,
	});
	await expect(status.getByRole("button", { name: "Reset Docker…" })).toBeDisabled();
});

test("the workspace dialog explains rebuild and offers a student no rebuild action", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));

	await page.getByTestId("workspace-status").click();
	const status = page.getByTestId("dialog-workspace-status");
	await expect(status.getByTestId("rebuild-note")).toContainText(
		"programs installed with sudo apt are not",
	);
	await expect(page.getByRole("button", { name: /Rebuild/ })).toHaveCount(0);

	// The route itself is for administrators only (SPEC.md §17.2).
	const response = await page.request.post(
		`/admin/workspaces/${student.workspaceId}/rebuild`,
		{ data: { resetDocker: false } },
	);
	expect(response.status()).toBeGreaterThanOrEqual(400);
	expect(await pendingOperation(student.workspaceId)).toBeNull();
});

test("Reset Docker works from the keyboard and returns focus to its button", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));

	await page.getByTestId("workspace-status").focus();
	await page.keyboard.press("Enter");
	const status = page.getByTestId("dialog-workspace-status");
	await expect(status).toBeVisible();
	const reset = status.getByRole("button", { name: "Reset Docker…" });
	// It stays disabled until the presence socket has reported the workspace.
	await expect(reset).toBeEnabled({ timeout: 15_000 });
	for (let step = 0; step < 10; step += 1) {
		if (await reset.evaluate((node) => node === document.activeElement)) break;
		await page.keyboard.press("Tab");
	}
	await expect(reset).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("dialog-reset-docker")).toBeVisible();

	await page.keyboard.press("Escape");
	await expect(page.getByTestId("dialog-reset-docker")).toHaveCount(0);
	await expect(reset).toBeFocused();
	expect(await pendingOperation(student.workspaceId)).toBeNull();
});

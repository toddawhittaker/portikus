/**
 * Recovery points in the web app (SPEC.md §10.9, §15.8): the dialog from the
 * project menu, restore behind a confirmation that names the project and the
 * time, the storage-full second confirmation, and Restore to before this
 * session. The fake agent keeps archives in memory.
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectNoViolations,
	query,
	readSeededFile,
	seedFile,
	setRecoveryFull,
	setRestoreIncomplete,
	type TestProject,
	workspacePath,
	workTabs,
} from "./helpers";

async function openRecovery(page: Page, project: TestProject): Promise<void> {
	await page.getByTestId(`project-menu-${project.id}`).click();
	await page.getByRole("menuitem", { name: "Recovery points…" }).click();
	await expect(page.getByTestId("dialog-recovery-points")).toBeVisible();
}

async function reasons(projectId: string): Promise<string[]> {
	const rows = await query<{ reason: string }>(
		"select reason from recovery_points where project_id = $1 order by created_at",
		[projectId],
	);
	return rows.map((row) => row.reason);
}

test("create, list and restore a point, confirmed with the project name and time", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Rescue Me" });
	await seedFile(student.workspaceId, project.slug, "notes.txt", "first draft\n");
	await page.goto(workspacePath(student.workspaceId, project.id));

	await openRecovery(page, project);
	const dialog = page.getByTestId("dialog-recovery-points");
	await expect(dialog.getByTestId("recovery-empty")).toBeVisible();
	await dialog.getByRole("button", { name: "Create recovery point now" }).click();
	await expect(dialog.getByTestId("recovery-status")).toHaveText(
		"Recovery point created.",
	);

	const row = dialog.locator("[data-testid^=recovery-row-]");
	await expect(row).toHaveCount(1);
	await expect(row).toContainText("Made by you");
	await expect(dialog.getByTestId("recovery-usage")).toContainText(
		"recovery storage used",
	);
	const when = (await row.locator("td").first().textContent()) ?? "";
	expect(when).not.toBe("");

	// The student's files change after the point.
	await seedFile(student.workspaceId, project.slug, "notes.txt", "broken\n");

	await row.getByRole("button", { name: `Restore to ${when}` }).click();
	const confirm = page.getByTestId("dialog-restore-point");
	await expect(confirm).toContainText(`Restore ${project.name} to ${when}?`);
	await expect(confirm).toContainText(
		"A recovery point of the current state is made first",
	);
	await confirm.getByRole("button", { name: "Restore", exact: true }).click();

	await expect(page.getByTestId("dialog-recovery-points")).toHaveCount(0);
	await expect
		.poll(() => readSeededFile(student.workspaceId, project.slug, "notes.txt"))
		.toBe("first draft\n");
	await expect.poll(() => reasons(project.id)).toEqual(["manual", "before-restore"]);
});

test("when recovery storage is full, restore offers to go ahead without saving", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Full Store" });
	await seedFile(student.workspaceId, project.slug, "a.txt", "good\n");
	await page.goto(workspacePath(student.workspaceId, project.id));

	await openRecovery(page, project);
	const dialog = page.getByTestId("dialog-recovery-points");
	await dialog.getByTestId("recovery-create").click();
	await expect(dialog.locator("[data-testid^=recovery-row-]")).toHaveCount(1);
	await seedFile(student.workspaceId, project.slug, "a.txt", "bad\n");
	await setRecoveryFull(student.workspaceId, true);

	await dialog.getByRole("button", { name: /^Restore to / }).click();
	await page
		.getByTestId("dialog-restore-point")
		.getByRole("button", { name: "Restore", exact: true })
		.click();
	const second = page.getByTestId("dialog-restore-without-safety");
	await expect(second).toContainText("Recovery storage is full");
	await second
		.getByRole("button", { name: "Restore without saving the current state" })
		.click();

	await expect
		.poll(() => readSeededFile(student.workspaceId, project.slug, "a.txt"))
		.toBe("good\n");
	expect(await reasons(project.id)).toEqual(["manual"]);
});

test("Restore to before this session puts back the files from before Claude Code started", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Agent Oops" });
	await seedFile(student.workspaceId, project.slug, "app.js", "working\n");
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });

	// Launching Claude Code makes the agent-session point (SPEC.md §10.9).
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-claude").click();
	await expect(page.getByRole("tab", { name: /Claude Code/ })).toBeVisible();
	await expect.poll(() => reasons(project.id)).toEqual(["agent-session"]);

	// The fake agent takes no Git baseline, so give the session one, then let
	// the agent "damage" the project.
	await query(
		"update terminals set baseline_object_id = $2 where project_id = $1 and agent = 'claude'",
		[project.id, "a".repeat(40)],
	);
	await seedFile(student.workspaceId, project.slug, "app.js", "broken by the agent\n");
	await page.reload();

	await page.getByTestId("review-session").click();
	await expect(page.getByTestId("changes-title")).toHaveText(
		"Changes since Claude session started",
	);
	await page.getByRole("button", { name: "Restore to before this session" }).click();
	const confirm = page.getByTestId("dialog-restore-point");
	await expect(confirm).toContainText(`Restore ${project.name} to`);
	await confirm.getByRole("button", { name: "Restore", exact: true }).click();

	await expect
		.poll(() => readSeededFile(student.workspaceId, project.slug, "app.js"))
		.toBe("working\n");
	await expect(confirm).toHaveCount(0);
	await expect(page.getByTestId("restore-session")).toBeFocused();
});

test("the recovery dialogs work from the keyboard alone and return focus", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Keys Only" });
	await page.goto(workspacePath(student.workspaceId, project.id));

	const menuButton = page.getByTestId(`project-menu-${project.id}`);
	await menuButton.focus();
	await page.keyboard.press("Enter");
	const item = page.getByRole("menuitem", { name: "Recovery points…" });
	await expect(item).toBeVisible();
	// Arrow down to the item, the way a keyboard user reaches it.
	for (let step = 0; step < 10; step += 1) {
		if (await item.evaluate((node) => node === document.activeElement)) break;
		await page.keyboard.press("ArrowDown");
	}
	await expect(item).toBeFocused();
	await page.keyboard.press("Enter");
	const dialog = page.getByTestId("dialog-recovery-points");
	await expect(dialog).toBeVisible();

	const create = dialog.getByRole("button", { name: "Create recovery point now" });
	for (let step = 0; step < 5; step += 1) {
		if (await create.evaluate((node) => node === document.activeElement)) break;
		await page.keyboard.press("Tab");
	}
	await expect(create).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(dialog.getByTestId("recovery-status")).toHaveText(
		"Recovery point created.",
	);
	await expect(dialog.getByTestId("recovery-status")).toHaveAttribute("role", "status");

	const restore = dialog.getByRole("button", { name: /^Restore to / });
	for (let step = 0; step < 5; step += 1) {
		if (await restore.evaluate((node) => node === document.activeElement)) break;
		await page.keyboard.press("Tab");
	}
	await expect(restore).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("dialog-restore-point")).toBeVisible();

	// Escape backs out one layer at a time, and focus goes back each time.
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("dialog-restore-point")).toHaveCount(0);
	await expect(restore).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(menuButton).toBeFocused();
});

test("a partly done restore says so and how to undo it", async ({ page, context }) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Half Done" });
	await page.goto(workspacePath(student.workspaceId, project.id));

	await openRecovery(page, project);
	const dialog = page.getByTestId("dialog-recovery-points");
	await dialog.getByTestId("recovery-create").click();
	await expect(dialog.locator("[data-testid^=recovery-row-]")).toHaveCount(1);
	await setRestoreIncomplete(student.workspaceId);

	await dialog.getByRole("button", { name: /^Restore to / }).click();
	const confirm = page.getByTestId("dialog-restore-point");
	await confirm.getByRole("button", { name: "Restore", exact: true }).click();
	await expect(confirm.getByTestId("restore-error")).toHaveText(
		"The project may be partly restored. Restore the 'Before restore' point to undo.",
	);
	await expect(confirm).not.toContainText("was not restored");
});

test("a kept folder from a partly done restore is listed and deleted after a confirmation", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Kept Copy" });
	await page.goto(workspacePath(student.workspaceId, project.id));

	await openRecovery(page, project);
	const dialog = page.getByTestId("dialog-recovery-points");
	await expect(dialog.getByRole("heading", { name: "Kept folders" })).toHaveCount(0);
	await dialog.getByTestId("recovery-create").click();
	const row = dialog.locator("[data-testid^=recovery-row-]");
	await expect(row).toHaveCount(1);
	const pointId = ((await row.getAttribute("data-testid")) ?? "").replace(
		"recovery-row-",
		"",
	);
	await setRestoreIncomplete(student.workspaceId);
	await dialog.getByRole("button", { name: /^Restore to / }).click();
	const confirm = page.getByTestId("dialog-restore-point");
	await confirm.getByRole("button", { name: "Restore", exact: true }).click();
	await expect(confirm.getByTestId("restore-error")).toContainText("partly restored");
	await confirm.getByRole("button", { name: "Cancel" }).click();

	const kept = dialog.getByTestId(`recovery-kept-${pointId}`);
	await expect(dialog.getByRole("heading", { name: "Kept folders" })).toBeVisible();
	await expect(kept).toContainText(`~/projects/.portikus-aside-${pointId}`);
	await expect(kept).toContainText("2 files, 2.0 KB");
	await expectNoViolations(page, '[data-testid="recovery-kept-list"]');

	// Escape closes only the confirmation.
	await kept
		.getByRole("button", { name: `Delete ~/projects/.portikus-aside-${pointId}` })
		.click();
	const ask = page.getByTestId("dialog-delete-kept-folder");
	await expect(ask).toContainText(
		`~/projects/.portikus-aside-${pointId} holds the files Kept Copy had before`,
	);
	await expectNoViolations(page, '[data-testid="dialog-delete-kept-folder"]');
	await page.keyboard.press("Escape");
	await expect(ask).toHaveCount(0);
	await expect(dialog).toBeVisible();

	await kept.getByRole("button", { name: /^Delete ~\/projects\// }).click();
	await ask.getByRole("button", { name: "Delete folder" }).click();
	await expect(dialog.getByTestId("recovery-status")).toHaveText(
		"Kept folder deleted.",
	);
	await expect(kept).toHaveCount(0);
	await expect(dialog.getByRole("heading", { name: "Kept folders" })).toHaveCount(0);
	await expect(
		dialog.getByRole("heading", { name: /^Recovery points for / }),
	).toBeFocused();

	const audit = await query<{ result: string }>(
		"select result from audit_events where action = 'recovery.aside_deleted' and target = $1",
		[project.id],
	);
	expect(audit.map((a) => a.result)).toEqual(["ok"]);
});

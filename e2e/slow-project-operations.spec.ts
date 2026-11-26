/**
 * Clone, duplicate and restore answer at once and finish on the server, so
 * none waits past a proxy's 100-second response timeout (SPEC.md §7.2, §7.3,
 * §15.8). The fake agent makes a "slow-motion" clone url or project slug take
 * a few seconds, long enough to see the progress and to reload part way.
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	projectIds,
	query,
	readSeededFile,
	seedFile,
	toast,
	workspacePath,
} from "./helpers";

async function projectAction(page: Page, projectId: string, action: string) {
	await page.getByTestId(`project-menu-${projectId}`).click();
	await page.getByRole("menuitem", { name: action }).click();
}

async function startClone(page: Page, name: string, url: string) {
	await page.getByTestId("new-project").click();
	await page.getByRole("menuitem", { name: "Clone repository" }).click();
	await page.getByTestId("field-name").fill(name);
	await page.getByTestId("field-url").fill(url);
	await page.getByTestId("dialog-confirm").click();
}

test("a slow clone shows Cloning… until it finishes, then opens the project", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	const answers: number[] = [];
	page.on("response", (response) => {
		if (
			response.request().method() === "POST" &&
			response.url().endsWith("/projects")
		) {
			answers.push(response.status());
		}
	});

	await startClone(page, "Slow Clone", "https://example.com/slow-motion.git");
	const confirm = page.getByTestId("dialog-confirm");
	await expect(confirm).toHaveText("Cloning…");
	await expect(confirm).toBeDisabled();
	// The request itself was answered at once.
	await expect.poll(() => answers).toEqual([202]);

	await expect(page.getByTestId("dialog-create-project")).toHaveCount(0, {
		timeout: 15_000,
	});
	const [projectId] = await projectIds(student.workspaceId);
	await expect(page).toHaveURL(new RegExp(`/projects/${projectId}`));
	await expect(page.getByTestId(`project-item-${projectId}`)).toContainText(
		"Slow Clone",
	);
});

test("a reload during a slow clone finds it again and offers the project", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	// Open on a project, so an empty workspace's jump to its first project does not interfere.
	const lab = await createProject(student.workspaceId, { name: "lab" });
	await page.goto(workspacePath(student.workspaceId, lab.id));
	await startClone(page, "Reload Clone", "https://example.com/slow-motion.git");
	await expect(page.getByTestId("dialog-confirm")).toHaveText("Cloning…");

	await page.reload();
	const url = page.url();
	await expect(toast(page, "Still creating your project…")).toBeVisible();
	const done = toast(page, "Reload Clone created");
	await expect(done).toBeVisible({ timeout: 15_000 });
	const ids = (await projectIds(student.workspaceId)).filter((id) => id !== lab.id);
	expect(ids).toHaveLength(1);
	// The page stays where the student is until they choose to open it.
	expect(page.url()).toBe(url);
	await done.getByRole("button", { name: "Open project" }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${ids[0]}`));

	// Shown once: another reload does not announce it again.
	await page.reload();
	await expect(page.getByTestId(`project-item-${ids[0]}`)).toBeVisible();
	await expect(toast(page, "Reload Clone created")).toHaveCount(0);

	// Nor does a second tab, which did not start it.
	const other = await context.newPage();
	await other.goto(workspacePath(student.workspaceId));
	await expect(other.getByTestId(`project-item-${ids[0]}`)).toBeVisible();
	await expect(toast(other, "Reload Clone created")).toHaveCount(0);
	await expect(other).not.toHaveURL(new RegExp(`/projects/${ids[0]}`));
	await other.close();
});

test("closing the dialog during a slow clone still announces how it went", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	// Open on a project, so an empty workspace's jump to its first project does not interfere.
	const lab = await createProject(student.workspaceId, { name: "lab" });
	await page.goto(workspacePath(student.workspaceId, lab.id));
	await startClone(page, "Closed Clone", "https://example.com/slow-motion.git");
	const confirm = page.getByTestId("dialog-confirm");
	await expect(confirm).toHaveText("Cloning…");
	// Focus stays on the busy button rather than falling out of the dialog.
	await expect(confirm).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("dialog-create-project")).toHaveCount(0);
	const url = page.url();

	const done = toast(page, "Closed Clone created");
	await expect(done).toBeVisible({ timeout: 15_000 });
	expect(page.url()).toBe(url);
	const [projectId] = (await projectIds(student.workspaceId)).filter(
		(id) => id !== lab.id,
	);
	await done.getByRole("button", { name: "Open project" }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${projectId}`));
});

test("a slow clone that fails shows the same error as before", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await startClone(page, "Slow Fail", "https://example.com/slow-motion-fail.git");
	await expect(page.getByTestId("dialog-confirm")).toHaveText("Cloning…");
	const dialog = page.getByTestId("dialog-create-project");
	await expect(dialog).toContainText(/could not|couldn't|failed/i, { timeout: 15_000 });
	expect(await projectIds(student.workspaceId)).toHaveLength(0);
});

test("a slow duplicate shows Duplicating…, survives a reload, and offers the copy", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "slow-motion lab" });
	await page.goto(workspacePath(student.workspaceId, project.id));

	await projectAction(page, project.id, "Duplicate");
	await page.getByTestId("field-name").fill("Lab Copy");
	await page.getByTestId("dialog-confirm").click();
	await expect(page.getByTestId("dialog-confirm")).toHaveText("Duplicating…");

	await page.reload();
	await expect(toast(page, "Still duplicating your project…")).toBeVisible();
	await expect(toast(page, "Lab Copy duplicated")).toBeVisible({ timeout: 15_000 });
	await expect.poll(async () => (await projectIds(student.workspaceId)).length).toBe(2);
	await expect(page.getByTestId("project-list")).toContainText("Lab Copy");
});

test("a slow restore keeps its dialog busy, then reports, and survives a reload", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, {
		name: "slow-motion notes",
	});
	await seedFile(student.workspaceId, project.slug, "notes.txt", "first draft\n");
	await page.goto(workspacePath(student.workspaceId, project.id));

	async function restoreFirstPoint() {
		await projectAction(page, project.id, "Recovery points…");
		const dialog = page.getByTestId("dialog-recovery-points");
		// The point made by hand; each restore adds a newer safety point.
		const row = dialog
			.locator("[data-testid^=recovery-row-]")
			.filter({ hasText: "Made by you" });
		await row.getByRole("button", { name: /^Restore to / }).click();
		await page
			.getByTestId("dialog-restore-point")
			.getByRole("button", { name: "Restore", exact: true })
			.click();
	}

	await projectAction(page, project.id, "Recovery points…");
	const dialog = page.getByTestId("dialog-recovery-points");
	await dialog.getByRole("button", { name: "Create recovery point now" }).click();
	await expect(dialog.getByTestId("recovery-status")).toHaveText(
		"Recovery point created.",
	);
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);

	// In the dialog: busy while it runs, then the usual success.
	await seedFile(student.workspaceId, project.slug, "notes.txt", "broken\n");
	await restoreFirstPoint();
	// While pending the label gains an ellipsis.
	const confirm = page
		.getByTestId("dialog-restore-point")
		.getByRole("button", { name: /^Restore…?$/ });
	await expect(confirm).toHaveAttribute("aria-busy", "true");
	await expect(toast(page, `${project.name} restored`)).toBeVisible({
		timeout: 15_000,
	});
	expect(await readSeededFile(student.workspaceId, project.slug, "notes.txt")).toBe(
		"first draft\n",
	);

	// Reloaded part way: the page finds the restore and says when it is done.
	await seedFile(student.workspaceId, project.slug, "notes.txt", "broken again\n");
	await restoreFirstPoint();
	await expect(confirm).toHaveAttribute("aria-busy", "true");
	await page.reload();
	await expect(toast(page, "Still restoring your project…")).toBeVisible();
	await expect(toast(page, "Project restored")).toBeVisible({ timeout: 15_000 });
	await expect
		.poll(() => readSeededFile(student.workspaceId, project.slug, "notes.txt"))
		.toBe("first draft\n");
	const audits = await query<{ result: string }>(
		"select result from audit_events where action = 'recovery.restored' and target = $1",
		[project.id],
	);
	expect(audits.map((row) => row.result)).toEqual(["ok", "ok"]);
});

test("a slow recovery point answers at once, and a closed dialog hands it to a toast", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, {
		name: "slow-points notes",
	});
	await seedFile(student.workspaceId, project.slug, "notes.txt", "first draft\n");
	await page.goto(workspacePath(student.workspaceId, project.id));
	const answers: number[] = [];
	page.on("response", (response) => {
		if (
			response.request().method() === "POST" &&
			response.url().endsWith("/recovery-points")
		) {
			answers.push(response.status());
		}
	});

	// In the dialog: busy while it runs, answered at once (SPEC.md 15.6).
	await projectAction(page, project.id, "Recovery points…");
	const dialog = page.getByTestId("dialog-recovery-points");
	const create = dialog.getByRole("button", { name: /^Create recovery point now/ });
	await create.click();
	await expect(create).toHaveAttribute("aria-busy", "true");
	await expect.poll(() => answers).toEqual([202]);
	await expect(dialog.getByTestId("recovery-status")).toHaveText(
		"Recovery point created.",
		{ timeout: 15_000 },
	);
	await expect(dialog.locator("[data-testid^=recovery-row-]")).toHaveCount(1);

	// Closed part way: the page follows it and says how it went. Points made
	// by hand are 30 seconds apart, so the clock is moved on in the database.
	await query(
		"update recovery_points set created_at = created_at - interval '1 minute' where project_id = $1",
		[project.id],
	);
	await create.click();
	await expect(create).toHaveAttribute("aria-busy", "true");
	await expect.poll(() => answers).toEqual([202, 202]);
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(toast(page, "Still making a recovery point…")).toBeVisible();
	await expect(toast(page, "Recovery point created")).toBeVisible({ timeout: 15_000 });
	const rows = await query<{ reason: string }>(
		"select reason from recovery_points where project_id = $1",
		[project.id],
	);
	expect(rows.map((row) => row.reason)).toEqual(["manual", "manual"]);
});

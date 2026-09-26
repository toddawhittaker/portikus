import { expect, type Page, test } from "@playwright/test";
import { displayNameFromDirectory } from "../packages/contracts/src/project.ts";
import {
	createProject,
	createStudent,
	moveProjectDir,
	projectDirs,
	projectIds,
	query,
	removeProjectDir,
	seedFile,
	seedProjectDir,
	toast,
	WEB_ORIGIN,
	workspacePath,
} from "./helpers";

/**
 * Project management (SPEC.md §7.1 to §7.4, §8.2). Written against the test
 * ids the shell builder owns (plan, E1). The orchestrator removes the guard
 * below once the Epic 6 shell and work area are merged.
 */
test.describe("projects", () => {
	/** Open the "New project" menu and pick one of its items. */
	async function startCreate(page: Page, item: string): Promise<void> {
		await page.getByTestId("new-project").click();
		await page.getByRole("menuitem", { name: item }).click();
		await expect(page.getByTestId("dialog-create-project")).toBeVisible();
	}

	/**
	 * Wait for the project rows a dialog is creating. The request runs while
	 * the dialog shows its pending label, so reading the table at once is a
	 * race.
	 */
	async function waitForProjectIds(
		workspaceId: string,
		count: number,
	): Promise<string[]> {
		await expect
			.poll(async () => (await projectIds(workspaceId)).length, { timeout: 15_000 })
			.toBe(count);
		return projectIds(workspaceId);
	}

	/** Open a project's "more" menu and pick one of its actions. */
	async function projectAction(
		page: Page,
		projectId: string,
		action: string,
	): Promise<void> {
		await page.getByTestId(`project-menu-${projectId}`).click();
		await page.getByRole("menuitem", { name: action }).click();
	}

	test("a new project is created with Git and shows its path", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await page.goto(workspacePath(student.workspaceId));
		await expect(page.getByTestId("empty-projects")).toBeVisible();

		await startCreate(page, "New project");
		await page.getByTestId("field-name").fill("My First Project");
		// The dialog previews the directory before it exists (plan, Rename).
		await expect(page.getByTestId("dialog-create-project")).toContainText(
			"~/projects/my-first-project",
		);
		await page.getByTestId("dialog-confirm").click();

		const [projectId] = await waitForProjectIds(student.workspaceId, 1);
		if (!projectId) throw new Error("no project row was created");
		await expect(page.getByTestId(`project-item-${projectId}`)).toContainText(
			"My First Project",
		);
		const [row] = await query<{ slug: string; path: string; source: string }>(
			"select slug, path, source from projects where id = $1",
			[projectId],
		);
		expect(row).toMatchObject({
			slug: "my-first-project",
			path: "/home/student/projects/my-first-project",
			source: "new",
		});
		// git init is the default (SPEC.md §7.2), so no Initialize Git action.
		await page.getByTestId(`project-menu-${projectId}`).click();
		await expect(page.getByRole("menuitem", { name: "Initialize Git" })).toHaveCount(0);
	});

	test("a name that would clash warns before Create is pressed", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await createProject(student.workspaceId, { name: "Todo API" });
		await page.goto(workspacePath(student.workspaceId));
		await expect(page.getByTestId("empty-projects")).toHaveCount(0);

		await startCreate(page, "New project");
		// Matching is by slug, so a different capitalisation still clashes.
		await page.getByTestId("field-name").fill("todo api");
		await expect(page.getByTestId("name-clash")).toHaveText(
			"A project called todo-api already exists",
		);
		await expect(page.getByTestId("dialog-confirm")).toBeDisabled();

		await page.getByTestId("field-name").fill("Todo API 2");
		await expect(page.getByTestId("name-clash")).toHaveCount(0);
		await expect(page.getByTestId("dialog-confirm")).toBeEnabled();
		await page.getByTestId("dialog-confirm").click();

		const ids = await waitForProjectIds(student.workspaceId, 2);
		expect(ids.length).toBe(2);
		const [created] = await query<{ slug: string }>(
			"select slug from projects where workspace_id = $1 and slug = $2",
			[student.workspaceId, "todo-api-2"],
		);
		expect(created?.slug).toBe("todo-api-2");
	});

	test("a project made without Git offers Initialize Git, and it works", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await page.goto(workspacePath(student.workspaceId));

		await startCreate(page, "New project");
		await page.getByTestId("field-name").fill("No Git Yet");
		await page.getByRole("checkbox", { name: /git/i }).uncheck();
		await page.getByTestId("dialog-confirm").click();

		const [projectId] = await waitForProjectIds(student.workspaceId, 1);
		if (!projectId) throw new Error("no project row was created");
		await projectAction(page, projectId, "Initialize Git");

		// Initializing must run real Git and make no commit (SPEC.md §7.2, §12.5).
		await expect
			.poll(async () => {
				const response = await page.request.get(
					`/workspaces/${student.workspaceId}/projects`,
				);
				const body = await response.json();
				return body.projects.find((project: { id: string }) => project.id === projectId)
					?.isGitRepo;
			})
			.toBe(true);
		await page.getByTestId(`project-menu-${projectId}`).click();
		await expect(page.getByRole("menuitem", { name: "Initialize Git" })).toHaveCount(0);
	});

	/** Issue #608 item 5: What to create is one segmented control. */
	test("New project shows exactly one pressed option and switches fields", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await page.goto(workspacePath(student.workspaceId));
		await startCreate(page, "New project");

		const group = page.getByRole("group", { name: "What to create" });
		const pressed = group.locator('button[aria-pressed="true"]');
		await expect(pressed).toHaveCount(1);
		await expect(pressed).toHaveText("New project");
		await expect(page.getByTestId("field-url")).toHaveCount(0);

		await group.getByRole("button", { name: "Clone repository" }).click();
		await expect(pressed).toHaveCount(1);
		await expect(pressed).toHaveText("Clone repository");
		await expect(page.getByTestId("field-url")).toBeVisible();
	});

	test("cloning a repository creates the project", async ({ page, context }) => {
		const student = await createStudent(context);
		await page.goto(workspacePath(student.workspaceId));

		await startCreate(page, "Clone repository");
		await page.getByTestId("field-name").fill("Cloned Work");
		await page.getByTestId("field-url").fill("https://example.com/repo.git");
		await page.getByTestId("dialog-confirm").click();

		const [projectId] = await waitForProjectIds(student.workspaceId, 1);
		if (!projectId) throw new Error("no project row was created");
		await expect(page.getByTestId(`project-item-${projectId}`)).toContainText(
			"Cloned Work",
		);
	});

	test("pasting a clone URL fills the name and slug", async ({ page, context }) => {
		const student = await createStudent(context);
		await page.goto(workspacePath(student.workspaceId));

		await startCreate(page, "Clone repository");
		await page.getByTestId("field-url").fill("https://github.com/user/todo-api");

		await expect(page.getByTestId("field-name")).toHaveValue("todo-api");
		await expect(page.getByTestId("slug-preview")).toHaveText("~/projects/todo-api");

		// The known hosts get the .git suffix added before the request is sent.
		const request = page.waitForRequest(
			(candidate) =>
				candidate.method() === "POST" && candidate.url().endsWith("/projects"),
		);
		await page.getByTestId("dialog-confirm").click();
		expect(JSON.parse((await request).postData() ?? "{}").url).toBe(
			"https://github.com/user/todo-api.git",
		);
	});

	test("a clone that fails explains itself and leaves no project", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await page.goto(workspacePath(student.workspaceId));

		await startCreate(page, "Clone repository");
		await page.getByTestId("field-name").fill("Broken Clone");
		// The fake agent refuses any url containing "fail".
		await page.getByTestId("field-url").fill("https://example.com/fail.git");
		await page.getByTestId("dialog-confirm").click();

		// Plain words first, then the detail (SPEC.md §28).
		await expect(page.getByTestId("dialog-create-project")).toContainText(
			/could not|couldn't|failed/i,
		);
		expect(await projectIds(student.workspaceId)).toEqual([]);
	});

	test("a rejected clone url never reaches the agent", async ({ page, context }) => {
		const student = await createStudent(context);
		await page.goto(workspacePath(student.workspaceId));

		await startCreate(page, "Clone repository");
		await page.getByTestId("field-name").fill("Local Repo");
		// file:// and ext:: are refused by the API (plan, Clone).
		await page.getByTestId("field-url").fill("file:///etc/passwd");
		await page.getByTestId("dialog-confirm").click();

		await expect(page.getByTestId("dialog-error")).toBeVisible();
		expect(await projectIds(student.workspaceId)).toEqual([]);
	});

	test("the template option is hidden when none are configured", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		// The API is started with one template, so empty it for this page only.
		await page.route("**/projects/templates", (route) =>
			route.fulfill({ json: { templates: [] } }),
		);
		await page.goto(workspacePath(student.workspaceId));

		await page.getByTestId("new-project").click();
		await expect(page.getByRole("menuitem", { name: "From template" })).toHaveCount(0);
		await expect(page.getByRole("menuitem", { name: "New project" })).toBeVisible();
	});

	test("a configured template can be used to create a project", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await page.goto(workspacePath(student.workspaceId));

		await startCreate(page, "From template");
		await page.getByTestId("field-name").fill("From Starter");
		await page.getByRole("combobox").click();
		await page.getByRole("option", { name: "Starter" }).click();
		await page.getByTestId("dialog-confirm").click();

		const [projectId] = await waitForProjectIds(student.workspaceId, 1);
		if (!projectId) throw new Error("no project row was created");
		await expect(page.getByTestId(`project-item-${projectId}`)).toContainText(
			"From Starter",
		);
	});

	test("renaming changes the slug and the terminal keeps working", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Old Name" });
		await query(
			`insert into terminals (id, workspace_id, project_id, name, cwd, position)
			 values (gen_random_uuid(), $1, $2, 'Terminal 1', $3, 0)`,
			[student.workspaceId, project.id, project.path],
		);
		await page.goto(workspacePath(student.workspaceId, project.id));

		await projectAction(page, project.id, "Rename");
		await page.getByTestId("field-name").fill("New Name");
		await expect(page.getByRole("dialog")).toContainText("~/projects/new-name");
		await page.getByTestId("dialog-confirm").click();

		await expect(page.getByTestId(`project-item-${project.id}`)).toContainText(
			"New Name",
		);
		// The directory moved, so the terminal's cwd moves with it (plan, Rename).
		await expect
			.poll(async () => {
				const rows = await query<{ cwd: string }>(
					"select cwd from terminals where project_id = $1",
					[project.id],
				);
				return rows[0]?.cwd;
			})
			.toBe("/home/student/projects/new-name");
	});

	test("duplicating a project makes a second one", async ({ page, context }) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Original" });
		await page.goto(workspacePath(student.workspaceId, project.id));

		await projectAction(page, project.id, "Duplicate");
		await page.getByTestId("field-name").fill("Original Copy");
		await page.getByTestId("dialog-confirm").click();

		await expect
			.poll(async () => (await projectIds(student.workspaceId)).length)
			.toBe(2);
		await expect(page.getByTestId("project-list")).toContainText("Original Copy");
		await expect(toast(page, "Original Copy created")).toBeVisible();
	});

	test("downloading a project gives a zip named after the slug", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Zip Me" });
		await page.goto(workspacePath(student.workspaceId, project.id));

		const downloadPromise = page.waitForEvent("download");
		// After the size check, the browser streams the zip to disk itself.
		await page.getByTestId(`project-menu-${project.id}`).click();
		await page.getByTestId("project-download").click();
		const download = await downloadPromise;

		expect(download.suggestedFilename()).toBe(`${project.slug}.zip`);
		expect(download.suggestedFilename().endsWith(".zip")).toBe(true);
		const path = await download.path();
		const { readFile } = await import("node:fs/promises");
		const head = (await readFile(path)).subarray(0, 2).toString("latin1");
		expect(head).toBe("PK");
	});

	test("archiving removes a project from the list and unarchiving brings it back", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Done With" });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId(`project-item-${project.id}`)).toBeVisible();

		await projectAction(page, project.id, "Archive");
		// Archiving is reversible, so it confirms with the primary button, not danger.
		const confirm = page.getByTestId("dialog-confirm");
		await expect(confirm).not.toHaveClass(/bg-status-danger/);
		await expect(confirm).toHaveClass(/bg-surface-inverse/);
		await confirm.click();

		await expect(page.getByTestId(`project-item-${project.id}`)).toHaveCount(0);
		await expect(toast(page, "Done With archived")).toContainText(
			"Find it under Archived projects.",
		);
		// Archiving never destroys the data (SPEC.md §7.4).
		expect(
			await query<{ state: string }>("select state from projects where id = $1", [
				project.id,
			]),
		).toEqual([{ state: "archived" }]);

		await page.getByTestId("archived-projects").click();
		await expect(page.getByTestId(`project-item-${project.id}`)).toBeVisible();
		await page.getByTestId(`project-unarchive-${project.id}`).click();

		await expect
			.poll(async () => {
				const rows = await query<{ state: string }>(
					"select state from projects where id = $1",
					[project.id],
				);
				return rows[0]?.state;
			})
			.toBe("active");
	});

	test("deleting a project requires typing its slug and removes it", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Scratch Pad" });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId(`project-item-${project.id}`)).toBeVisible();

		await projectAction(page, project.id, "Delete project");
		await expect(page.getByTestId("dialog-delete-project")).toContainText(project.path);
		const dialog = page.getByTestId("dialog-delete-project");
		const button = dialog.getByTestId("dialog-confirm");
		await expect(button).toBeDisabled();

		await dialog.getByRole("textbox").fill("scratch-pa");
		await expect(button).toBeDisabled();

		await dialog.getByRole("textbox").fill(project.slug);
		await expect(button).toBeEnabled();
		await button.click();

		await expect(page.getByTestId(`project-item-${project.id}`)).toHaveCount(0);
		await expect
			.poll(
				async () =>
					(await query("select id from projects where id = $1", [project.id])).length,
			)
			.toBe(0);
		// The folder is gone too (SPEC.md 7.3).
		expect(await projectDirs(student.workspaceId)).not.toContain(project.slug);
	});

	test("a Git directory made by hand is discovered", async ({ page, context }) => {
		const student = await createStudent(context);
		const slug = `found-${Date.now()}`;
		await seedProjectDir(student.workspaceId, slug, true);
		// A directory that is not a Git repository is ignored (plan, Discovery).
		await seedProjectDir(student.workspaceId, `${slug}-plain`, false);

		await page.goto(workspacePath(student.workspaceId));

		await expect(page.getByTestId("project-list")).toContainText(
			displayNameFromDirectory(slug),
		);
		await expect(page.getByTestId("project-list")).not.toContainText(
			displayNameFromDirectory(`${slug}-plain`),
		);
		const rows = await query<{ slug: string; source: string }>(
			"select slug, source from projects where workspace_id = $1",
			[student.workspaceId],
		);
		expect(rows).toEqual([{ slug, source: "discovered" }]);
	});

	test("a repository created from the shell shows up without any UI action", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await page.goto(workspacePath(student.workspaceId));
		// The pane is open and empty; an empty list has no height, so wait on the button.
		await expect(page.getByTestId("new-project")).toBeVisible();

		// The student makes the repository in a terminal, with the pane already open.
		const slug = `shell-${Date.now()}`;
		await seedProjectDir(student.workspaceId, slug, true);

		// The pane polls, so the row turns up on its own (SPEC.md §7.6).
		await expect(page.getByTestId("project-list")).toContainText(
			displayNameFromDirectory(slug),
			{ timeout: 15_000 },
		);
	});

	test("a project whose directory is gone is shown as missing", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, {
			name: `Vanished ${Date.now()}`,
		});
		await removeProjectDir(student.workspaceId, project.slug);

		await page.goto(workspacePath(student.workspaceId));

		const item = page.getByTestId(`project-item-${project.id}`);
		await expect(item).toContainText(/missing/i);
		// Archive is the only action left on a missing project (plan, Discovery).
		await page.getByTestId(`project-menu-${project.id}`).click();
		await expect(page.getByRole("menuitem", { name: "Archive" })).toBeVisible();
		await expect(page.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);
		await expect(page.getByRole("menuitem", { name: "Download" })).toHaveCount(0);
	});

	/** Issue #238: `mv` in the shell keeps the project, its id and its layout. */
	test("a project renamed in the shell keeps its row and its tabs", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Todo api" });
		await seedFile(
			student.workspaceId,
			project.slug,
			"app.ts",
			"export const a = 1;\n",
		);
		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify({
				tabs: [{ id: "file:app.ts", root: { type: "file", path: "app.ts" } }],
			}),
		]);

		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId(`project-item-${project.id}`)).toBeVisible({
			timeout: 15_000,
		});

		// The student renames the folder in a shell.
		await moveProjectDir(student.workspaceId, project.slug, "todo-service");

		// The same project, under its new name, with its tab still open.
		// The title is read from the folder, so it changes too (issue #269).
		const item = page.getByTestId(`project-item-${project.id}`);
		await expect(item).toContainText("Todo Service", { timeout: 20_000 });
		await expect(item).not.toContainText("todo-service");
		await expect(item).not.toContainText(/missing/i);
		await expect(page.getByTestId("tab-file:app.ts")).toBeAttached();

		// One row, not two: the new folder was not discovered as a new project.
		const rows = await query<{ count: string }>(
			"select count(*)::text as count from projects where workspace_id = $1",
			[student.workspaceId],
		);
		expect(rows[0]?.count).toBe("1");
	});

	test("another student's project is not readable", async ({ page, browser }) => {
		const owner = await browser.newContext({ baseURL: WEB_ORIGIN });
		const student = await createStudent(owner);
		const project = await createProject(student.workspaceId, { name: "Private" });
		await owner.close();

		// The signed-in user of `page` is a different student.
		await createStudent(page.context());

		const listed = await page.request.get(
			`/workspaces/${student.workspaceId}/projects`,
		);
		expect(listed.status()).toBe(404);
		const read = await page.request.get(
			`/workspaces/${student.workspaceId}/projects/${project.id}/download`,
		);
		expect(read.status()).toBe(404);

		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId("project-list")).toHaveCount(0);
	});

	test("the three-dots menu stays visible when the pane is dragged narrow", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, {
			name: "A Very Long Project Name That Will Not Fit In A Narrow Pane",
		});
		await page.goto(workspacePath(student.workspaceId, project.id));

		const menu = page.getByTestId(`project-menu-${project.id}`);
		await expect(menu).toBeVisible();

		// Drag the handle as far left as it goes; the pane stops at its minSize.
		const handle = page.getByRole("separator", { name: "Resize project list" });
		const grip = await handle.boundingBox();
		if (!grip) throw new Error("the project pane handle has no box");
		await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
		await page.mouse.down();
		await page.mouse.move(0, grip.y + grip.height / 2, { steps: 10 });
		await page.mouse.up();

		const pane = page.getByRole("navigation", { name: "Projects" });
		const paneBox = await pane.boundingBox();
		const menuBox = await menu.boundingBox();
		if (!paneBox || !menuBox) throw new Error("the pane or its menu has no box");
		expect(menuBox.width).toBeGreaterThan(0);
		expect(menuBox.x).toBeGreaterThanOrEqual(paneBox.x);
		expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(
			paneBox.x + paneBox.width + 1,
		);

		// The head's "New project" button stays reachable too.
		const newBox = await page.getByTestId("new-project").boundingBox();
		if (!newBox) throw new Error("the new project button has no box");
		expect(newBox.x + newBox.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1);

		await menu.click();
		await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
	});
});

import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	projectIds,
	query,
	removeProjectDir,
	seedProjectDir,
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
	});

	test("downloading a project gives a zip named after the slug", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Zip Me" });
		await page.goto(workspacePath(student.workspaceId, project.id));

		const downloadPromise = page.waitForEvent("download");
		await projectAction(page, project.id, "Download");
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
		await page.getByTestId("dialog-confirm").click();

		await expect(page.getByTestId(`project-item-${project.id}`)).toHaveCount(0);
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

	test("a Git directory made by hand is discovered", async ({ page, context }) => {
		const student = await createStudent(context);
		const slug = `found-${Date.now()}`;
		await seedProjectDir(student.workspaceId, slug, true);
		// A directory that is not a Git repository is ignored (plan, Discovery).
		await seedProjectDir(student.workspaceId, `${slug}-plain`, false);

		await page.goto(workspacePath(student.workspaceId));

		await expect(page.getByTestId("project-list")).toContainText(slug);
		await expect(page.getByTestId("project-list")).not.toContainText(`${slug}-plain`);
		const rows = await query<{ slug: string; source: string }>(
			"select slug, source from projects where workspace_id = $1",
			[student.workspaceId],
		);
		expect(rows).toEqual([{ slug, source: "discovered" }]);
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
});

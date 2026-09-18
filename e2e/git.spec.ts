import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	pushEvent,
	seedFile,
	seedGit,
	type TestProject,
	workspacePath,
} from "./helpers";

/**
 * Git decorations, the compact branch line and the Changes list
 * (SPEC.md §12.1, §12.3, §12.6, §12.8), and the live updates that keep them
 * right without a reload (SPEC.md §11.4, §25.1).
 */
test.describe("git status in the workspace", () => {
	function statusFor(entries: unknown[], extra: Record<string, unknown> = {}) {
		return {
			repo: true,
			branch: "main",
			detached: false,
			upstream: "origin/main",
			ahead: 2,
			behind: 0,
			conflicts: 1,
			entries,
			ignored: [],
			truncated: false,
			...extra,
		};
	}

	const entries = [
		{ path: "README.md", x: ".", y: "M", unmerged: false },
		{ path: "new.ts", x: "?", y: "?", unmerged: false },
		{ path: "conflict.ts", x: "U", y: "U", unmerged: true },
		{ path: "gone.ts", x: ".", y: "D", unmerged: false },
		{ path: "renamed.ts", x: "R", y: ".", unmerged: false, origPath: "old.ts" },
	];

	async function openProject(
		page: Page,
		workspaceId: string,
		name: string,
		status: unknown = statusFor(entries),
	): Promise<TestProject> {
		const project = await createProject(workspaceId, { name });
		for (const path of ["README.md", "new.ts", "conflict.ts", "renamed.ts"]) {
			await seedFile(workspaceId, project.slug, path, "x\n");
		}
		await seedGit(workspaceId, project.slug, { status });
		await page.goto(workspacePath(workspaceId, project.id));
		await expect(page.getByTestId("file-tree")).toBeVisible({ timeout: 15_000 });
		return project;
	}

	test("the tree, the status bar and the Changes list show the repository state", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openProject(page, student.workspaceId, "Decorated");

		// Each row carries its own state, and a conflict is not a modification
		// (SPEC.md §12.1, §12.8).
		await expect(page.getByTestId("file-row-README.md")).toHaveAttribute(
			"data-git",
			"modified",
		);
		await expect(page.getByTestId("file-row-new.ts")).toHaveAttribute(
			"data-git",
			"untracked",
		);
		await expect(page.getByTestId("file-row-conflict.ts")).toHaveAttribute(
			"data-git",
			"conflict",
		);
		await expect(page.getByTestId("file-row-renamed.ts")).toHaveAttribute(
			"data-git",
			"renamed",
		);

		await expect(page.getByTestId("git-status")).toHaveText(
			"main • 5 changes • 1 conflict • 2 commits ahead",
		);

		await expect(page.getByTestId("changes-title")).toHaveText("Changes (5)");
		const rows = page.getByTestId("changes-list").getByRole("button");
		await expect(rows).toHaveCount(5);
		// The letter and the path are separate elements, so the text runs together.
		await expect(page.getByTestId("change-row-README.md")).toContainText("MREADME.md");
		await expect(page.getByTestId("change-row-renamed.ts")).toContainText(
			"old.ts → renamed.ts",
		);
		// The conflict row is styled apart from the modified one.
		await expect(page.getByTestId("change-row-conflict.ts")).toHaveAttribute(
			"data-git",
			"conflict",
		);
		await expect(page.getByTestId("change-row-README.md")).toHaveAttribute(
			"data-git",
			"modified",
		);
	});

	test("choosing a change opens its diff tab", async ({ page, context }) => {
		const student = await createStudent(context);
		await openProject(page, student.workspaceId, "Open diff");

		await page.getByTestId("change-row-README.md").click();
		await expect(page.getByTestId("tab-diff:README.md")).toBeVisible();
	});

	test("a project with no repository says so and offers nothing else", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openProject(
			page,
			student.workspaceId,
			"Plain folder",
			statusFor([], {
				repo: false,
				branch: null,
				upstream: null,
				ahead: 0,
				conflicts: 0,
			}),
		);

		await expect(page.getByTestId("git-status")).toHaveText("not a git repository");
		await expect(page.getByTestId("changes-no-repo")).toBeVisible();
		await expect(page.getByTestId("changes-list")).toHaveCount(0);
	});

	test("a change made outside the browser updates the screen without a reload", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openProject(page, student.workspaceId, "Live");
		await expect(page.getByTestId("changes-title")).toHaveText("Changes (5)");

		// The shell committed most of the work, so Git now reports one change.
		await seedGit(student.workspaceId, project.slug, {
			status: statusFor([{ path: "README.md", x: ".", y: "M", unmerged: false }], {
				conflicts: 0,
			}),
		});
		await expect
			.poll(
				() =>
					pushEvent(student.workspaceId, project.slug, {
						type: "fs",
						paths: [],
						git: true,
						truncated: false,
					}),
				{ timeout: 15_000 },
			)
			.toBeGreaterThan(0);

		// SPEC.md §25.1: a change on disk is on screen within two seconds.
		await expect(page.getByTestId("changes-title")).toHaveText("Changes (1)", {
			timeout: 2000,
		});
		await expect(page.getByTestId("git-status")).toHaveText(
			"main • 1 change • 2 commits ahead",
		);
	});

	// SPEC.md §12.3: a shell that edits a tracked file sends an ordinary
	// filesystem event, with no Git flag, and the decorations must still move.
	test("an ordinary file change refreshes the Git decorations too", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openProject(page, student.workspaceId, "Plain edit");
		await expect(page.getByTestId("changes-title")).toHaveText("Changes (5)");
		await expect(page.getByTestId("file-row-new.ts")).toHaveAttribute(
			"data-git",
			"untracked",
		);

		// The file was added to the index, so it is no longer untracked and two
		// other changes are gone.
		await seedGit(student.workspaceId, project.slug, {
			status: statusFor(
				[
					{ path: "README.md", x: ".", y: "M", unmerged: false },
					{ path: "new.ts", x: "A", y: ".", unmerged: false },
				],
				{ conflicts: 0 },
			),
		});
		await expect
			.poll(
				() =>
					pushEvent(student.workspaceId, project.slug, {
						type: "fs",
						paths: ["new.ts"],
						git: false,
						truncated: false,
					}),
				{ timeout: 15_000 },
			)
			.toBeGreaterThan(0);

		await expect(page.getByTestId("changes-title")).toHaveText("Changes (2)", {
			timeout: 2000,
		});
		await expect(page.getByTestId("file-row-new.ts")).toHaveAttribute(
			"data-git",
			"added",
		);
	});

	test("a file created outside the browser appears in the tree without a reload", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openProject(page, student.workspaceId, "Live tree");
		await expect(page.getByTestId("file-row-fresh.ts")).toHaveCount(0);

		await seedFile(student.workspaceId, project.slug, "fresh.ts", "made in a shell\n");
		await expect
			.poll(
				() =>
					pushEvent(student.workspaceId, project.slug, {
						type: "fs",
						paths: ["fresh.ts"],
						git: false,
						truncated: false,
					}),
				{ timeout: 15_000 },
			)
			.toBeGreaterThan(0);

		await expect(page.getByTestId("file-row-fresh.ts")).toBeVisible({
			timeout: 2000,
		});
	});
});

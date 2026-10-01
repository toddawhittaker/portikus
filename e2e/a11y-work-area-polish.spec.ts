/**
 * The Epic 25 work-area polish, in both colour schemes (SPEC.md §25.8):
 * the refused-port preview, the diff's named columns, Markdown task lists,
 * a file tree that shows no selection until it has focus, and the terminal
 * menu's Light terminal checkbox.
 */
import { expect, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	expectNoViolations,
	newTerminal,
	openFileTab,
	openToggletip,
	query,
	seedFile,
	seedGit,
	seedListening,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";

async function saveLayout(projectId: string, tabs: unknown[]): Promise<void> {
	await query("update projects set layout = $2 where id = $1", [
		projectId,
		JSON.stringify({ tabs }),
	]);
}

for (const colorScheme of ["light", "dark"] as const) {
	test.describe(`work area polish (${colorScheme})`, () => {
		test.describe.configure({ timeout: 90_000 });

		test.beforeEach(async ({ page }) => {
			await page.emulateMedia({ colorScheme });
		});

		test("a refused port says why and offers another port", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			await seedListening(student.workspaceId, [{ port: 5432 }]);
			const project = await createProject(student.workspaceId, { name: "Refused" });
			await saveLayout(project.id, [
				{ id: "preview:5432", root: { type: "preview", port: 5432 } },
			]);
			await page.goto(workspacePath(student.workspaceId, project.id));
			await expect(
				page.getByRole("heading", { name: "Port 5432 cannot be previewed" }),
			).toBeVisible({ timeout: 20_000 });
			await expect(page.getByTestId("preview-retry")).toHaveCount(0);
			await expectNoViolations(page, '[data-testid="preview-pane-5432"]');

			// The keyboard reaches the action, and it opens the port picker.
			await page.getByRole("button", { name: "Choose another port…" }).focus();
			await page.keyboard.press("Enter");
			await expect(page.getByTestId("dialog-preview-port")).toBeVisible();
		});

		test("a diff names its two columns and its status in words", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const project = await createProject(student.workspaceId, { name: "Columns" });
			await seedGit(student.workspaceId, project.slug, {
				diffs: {
					"src/app.ts": {
						status: "M",
						before: "const answer = 1;\n",
						after: "const answer = 42;\n",
						binary: false,
						tooLarge: false,
					},
				},
			});
			await saveLayout(project.id, [
				{ id: "diff:src/app.ts", root: { type: "diff", path: "src/app.ts" } },
			]);
			await page.goto(workspacePath(student.workspaceId, project.id));
			await expect(page.getByTestId("diff-status-src/app.ts")).toHaveText("Modified", {
				timeout: 15_000,
			});
			const sides = page.getByTestId("diff-sides");
			await expect(sides.locator("span").first()).toHaveText("Last commit");
			await expect(sides.locator("span").last()).toHaveText("Your changes");
			await expectNoViolations(
				page,
				'[data-testid="diff-pane-src/app.ts"] .pk-file-header',
			);
			await expectNoViolations(page, '[data-testid="diff-sides"]');
		});

		test("a Markdown task list shows checkboxes in place of bullets", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			await openFileTab(
				page,
				student,
				"Tasks",
				"TODO.md",
				"- [ ] Write the tests\n- [x] Read the spec\n",
			);
			const preview = page.getByTestId("markdown-preview");
			await expect(preview).toBeVisible({ timeout: 30_000 });
			const item = preview.locator("li").first();
			await expect(item).toHaveCSS("list-style-type", "none");
			// The checkbox sits in the bullet's gutter, left of the text.
			const box = await item.locator('input[type="checkbox"]').boundingBox();
			const itemBox = await item.boundingBox();
			if (!box || !itemBox) throw new Error("the task item was not laid out");
			expect(box.x + box.width).toBeLessThanOrEqual(itemBox.x);
			await expectNoViolations(page, '[data-testid="markdown-preview"]');
		});

		test("the file tree shows no selected row until it has focus", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const project = await createProject(student.workspaceId, { name: "Unselected" });
			await seedFile(student.workspaceId, project.slug, "a.txt", "a\n");
			await seedFile(student.workspaceId, project.slug, "b.txt", "b\n");
			await page.goto(workspacePath(student.workspaceId, project.id));
			const row = page.getByTestId("file-row-a.txt");
			await expect(row).toBeVisible({ timeout: 15_000 });
			const paint = row.locator("> .pk-tree-row");
			await expect(paint).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

			// Reaching the tree by keyboard paints the row it lands on.
			await row.focus();
			await expect(paint).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
			await expectNoViolations(page, '[role="tree"]');
		});

		test("Review session changes has a toggletip with no violations", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const project = await createProject(student.workspaceId, { name: "Review Tip" });
			await page.goto(workspacePath(student.workspaceId, project.id));
			await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
			await page.getByTestId("launcher").click();
			await page.getByTestId("launcher-claude").click();
			await expect(page.getByRole("tab", { name: /Claude Code/ })).toBeVisible();
			// The fake agent takes no Git baseline, so give the session one.
			await expect
				.poll(
					async () =>
						(
							await query(
								"update terminals set baseline_object_id = $2 where project_id = $1 and agent = 'claude' returning id",
								[project.id, "a".repeat(40)],
							)
						).length,
				)
				.toBe(1);
			await page.reload();

			const tip = page.getByRole("button", { name: "About Review session changes" });
			await expect(tip).toBeVisible({ timeout: 15_000 });
			await tip.focus();
			await page.keyboard.press("Enter");
			await expect(openToggletip(page)).toHaveText(
				"Shows only what changed since this agent session started, not everything since your last commit. Files Git ignores are left out, except .env files at the project root.",
			);
			await expectNoViolations(page, '[data-testid="changes-section"]');
			await expectNoViolations(page, ".pk-toggletip-content");
			await page.keyboard.press("Escape");
			await expect(tip).toBeFocused();
		});

		test("Clone repository uses the download icon", async ({ page, context }) => {
			const student = await createStudent(context);
			await createProject(student.workspaceId, { name: "Icons" });
			await page.goto(workspacePath(student.workspaceId));
			await page.getByTestId("new-project").click();
			const item = page.getByRole("menuitem", { name: "Clone repository…" });
			await expect(item).toBeVisible({ timeout: 15_000 });
			// The download arrow ends in a chevron; the old external icon did not.
			await expect(item.locator('svg path[d="M7 10l5 5 5-5"]')).toHaveCount(1);
		});

		test("the terminal menu has a Light terminal checkbox", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const project = await createProject(student.workspaceId, { name: "Colours" });
			await page.goto(workspacePath(student.workspaceId, project.id));
			await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
			await newTerminal(page);
			await expect
				.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
				.toBe(1);
			const [id] = await terminalIds(student.workspaceId, project.id);
			if (!id) throw new Error("the terminal row was not created");
			await expectConnected(page, id);

			await page.getByTestId(`terminal-actions-${id}`).focus();
			await page.keyboard.press("Enter");
			const item = page.getByRole("menuitemcheckbox", { name: "Light terminal" });
			await expect(item).not.toBeChecked();
			await expectNoViolations(page, '[role="menu"]');
			await item.focus();
			await page.keyboard.press("Enter");
			await expect(page.getByTestId(`terminal-leaf-${id}`)).toHaveAttribute(
				"data-terminal-theme",
				"light",
			);
		});
	});
}

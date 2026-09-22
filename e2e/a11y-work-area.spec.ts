/**
 * Keyboard and screen reader paths through the work area (SPEC.md §25.8):
 * moving a pane without a drag, leaving a terminal from its menu, tab panels
 * named by their tabs, and focus kept across the Edit and Diff swap.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	newTerminal,
	openFileTab,
	seedGit,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";

/** Open a terminal pane's actions menu and choose an item, by keyboard only. */
async function chooseFromActions(page: Page, terminalId: string, item: string) {
	await page.getByTestId(`terminal-actions-${terminalId}`).focus();
	await page.keyboard.press("Enter");
	const menuItem = page.getByRole("menuitem", { name: item });
	await expect(menuItem).toBeVisible();
	await menuItem.focus();
	await page.keyboard.press("Enter");
}

async function openTerminal(page: Page, workspaceId: string, projectId: string) {
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(workspaceId, projectId)).length)
		.toBe(1);
	const [id] = await terminalIds(workspaceId, projectId);
	if (!id) throw new Error("the terminal row was not created");
	await expectConnected(page, id);
	return id;
}

function helperTextarea(page: Page, id: string): Locator {
	return page.locator(`[data-testid="terminal-pane-${id}"] .xterm-helper-textarea`);
}

test("a split pane moves to a tab of its own from the keyboard", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Move Pane" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	const first = await openTerminal(page, student.workspaceId, project.id);

	await chooseFromActions(page, first, "Split right");
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(2);
	const second = (await terminalIds(student.workspaceId, project.id)).find(
		(id) => id !== first,
	);
	if (!second) throw new Error("the split did not create a terminal");
	await expectConnected(page, second);
	await expect(workTabs(page).getByRole("tab")).toHaveCount(1);

	await chooseFromActions(page, second, "Move to new tab");

	await expect(workTabs(page).getByRole("tab")).toHaveCount(2);
	await expect(workTabs(page).getByRole("tab").nth(1)).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(helperTextarea(page, second)).toBeFocused();

	// A pane alone in its tab already has a tab of its own.
	await page.getByTestId(`terminal-actions-${second}`).focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("menuitem", { name: "Move to new tab" })).toHaveAttribute(
		"aria-disabled",
		"true",
	);
	await page.keyboard.press("Escape");
});

test("Leave terminal in the menu names Alt+Shift+Q and moves to the tab", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Leave Terminal" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	const id = await openTerminal(page, student.workspaceId, project.id);

	await page.getByTestId(`terminal-actions-${id}`).focus();
	await page.keyboard.press("Enter");
	const leave = page.getByRole("menuitem", { name: /Leave terminal/ });
	await expect(leave).toHaveAttribute("aria-keyshortcuts", "Alt+Shift+Q");
	await leave.focus();
	await page.keyboard.press("Enter");

	await expect(workTabs(page).getByRole("tab", { selected: true })).toBeFocused();
});

test("each work-area tab panel is named by its tab", async ({ page, context }) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Panel Names" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await openTerminal(page, student.workspaceId, project.id);

	const tab = page.getByRole("tab", { name: /Terminal 1/ });
	const controls = await tab.getAttribute("aria-controls");
	expect(controls).toBeTruthy();
	const panel = page.locator(`[id="${controls}"]`);
	await expect(panel).toHaveAttribute("role", "tabpanel");
	await expect(page.getByRole("tabpanel", { name: /Terminal 1/ })).toBeVisible();
});

test("a light terminal's focus ring uses the light focus colour", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Light Ring" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	const id = await openTerminal(page, student.workspaceId, project.id);
	const pane = page.getByTestId(`terminal-leaf-${id}`);

	await chooseFromActions(page, id, "Light terminal");
	await expect(pane).toHaveAttribute("data-terminal-theme", "light");
	await expect(pane).toHaveCSS("outline-color", "rgb(27, 122, 134)");
});

test.describe("Edit and Diff", () => {
	test.describe.configure({ timeout: 90_000 });
	const PATH = "src/app.ts";

	test("the swap keeps the keyboard on the pressed button", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openFileTab(page, student, "View Swap", PATH, "b\n");
		await seedGit(student.workspaceId, project.slug, {
			diffs: {
				[PATH]: {
					status: "M",
					before: "a\n",
					after: "b\n",
					binary: false,
					tooLarge: false,
				},
			},
		});

		await page.getByTestId(`file-view-diff-${PATH}`).focus();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId(`diff-pane-${PATH}`)).toBeVisible();
		const diff = page.getByTestId(`file-view-diff-${PATH}`);
		await expect(diff).toBeFocused();
		await expect(diff).toHaveAttribute("aria-pressed", "true");
		await expect(diff).toHaveCSS("font-weight", "700");

		await page.keyboard.press("Shift+Tab");
		await expect(page.getByTestId(`file-view-edit-${PATH}`)).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId(`diff-pane-${PATH}`)).toBeHidden();
		await expect(page.getByTestId(`file-view-edit-${PATH}`)).toBeFocused();
	});
});

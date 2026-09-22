/**
 * A terminal opened from the New menu takes the keyboard straight away
 * (SPEC.md §10.2).
 */
import { expect, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";

test("a terminal opened from the New menu takes the keyboard", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Launcher Focus" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });

	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-terminal").click();

	await expect(page.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
	const [id] = await terminalIds(student.workspaceId, project.id);
	if (!id) throw new Error("the terminal row was not created");
	await expectConnected(page, id);

	// No click into the pane: the shell's own field has the keyboard.
	await expect(
		page.locator(`[data-testid="terminal-pane-${id}"] .xterm-helper-textarea`),
	).toBeFocused();
});

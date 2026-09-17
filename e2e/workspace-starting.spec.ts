import { expect, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	setWorkspaceState,
	workspacePath,
	workTabs,
} from "./helpers";

/**
 * The starting screen and the move to the work area (SPEC.md §6.3, §6.7).
 * The worker does not run here, so the test moves the workspace row itself
 * and the presence socket pushes the change to the page.
 */
test("the starting screen gives way to the terminal tabs", async ({
	page,
	context,
}) => {
	const student = await createStudent(context, { state: "starting" });
	const project = await createProject(student.workspaceId, { name: "Starting" });

	await page.goto(workspacePath(student.workspaceId, project.id));

	await expect(page.getByTestId("workspace-state")).toHaveText("Starting");
	await expect(
		page.getByRole("heading", { name: "Starting your workspace" }),
	).toBeVisible();
	await expect(workTabs(page)).toHaveCount(0);

	await setWorkspaceState(student.workspaceId, "running");

	// No reload: the workspace WebSocket reports the new state.
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await expect(page.getByText("No terminals open")).toBeVisible();
	await expect(page.getByTestId("launcher")).toBeVisible();
});

import { expect, test } from "@playwright/test";
import { createStudent, setWorkspaceState } from "./helpers";

/**
 * The starting screen and the move to the terminal screen (SPEC.md §6.3,
 * §6.7). The worker does not run here, so the test moves the workspace row
 * itself and the presence socket pushes the change to the page.
 */
test("the starting screen gives way to the terminal tabs", async ({
	page,
	context,
}) => {
	const student = await createStudent(context, { state: "starting" });

	await page.goto(`/workspaces/${student.workspaceId}`);

	await expect(page.getByTestId("workspace-state")).toHaveText(
		"Starting your workspace…",
	);
	await expect(page.getByRole("tablist", { name: "Terminals" })).toHaveCount(0);

	await setWorkspaceState(student.workspaceId, "running");

	// No reload: the workspace WebSocket reports the new state.
	await expect(page.getByRole("tablist", { name: "Terminals" })).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByText("No terminals yet.")).toBeVisible();
});

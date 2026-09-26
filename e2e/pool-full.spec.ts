import { expect, test } from "@playwright/test";
import { createStudent, query, workspacePath } from "./helpers";

/**
 * A new workspace refused because the storage pool is full stays in
 * provisioning, and the student sees why (SPEC.md §20.1). No worker runs in
 * e2e, so the test writes the row the worker would.
 */
const MESSAGE =
	"There is no room for a new workspace right now. Your administrator has been told.";

test("a new workspace waiting for room in the storage pool says why", async ({
	page,
	context,
}) => {
	const student = await createStudent(context, { state: "provisioning" });
	await query(
		"update workspaces set error_code = 'POOL_FULL', error_message = $2 where id = $1",
		[student.workspaceId, MESSAGE],
	);

	await page.goto(workspacePath(student.workspaceId));

	const progress = page.getByTestId("workspace-progress");
	await expect(progress).toHaveAttribute("data-phase", "starting", { timeout: 15_000 });
	await expect(page.getByTestId("workspace-waiting")).toHaveText(MESSAGE);
});

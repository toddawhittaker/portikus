import { expect, test } from "@playwright/test";
import { createProject, createStudent, seedFile, workspacePath } from "./helpers";

/**
 * With hidden files shown, a change inside a generated folder reaches the
 * open tree without a reload (SPEC.md §11.3, §11.4).
 */
test("a new file in an expanded node_modules appears live while hidden files show", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Generated" });
	await seedFile(student.workspaceId, project.slug, "node_modules/old.js", "x\n");
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(page.getByTestId("file-tree")).toBeVisible({ timeout: 15_000 });

	await page.getByTestId("file-row-node_modules").click();
	await expect(page.getByTestId("file-row-node_modules/old.js")).toBeVisible();

	// An ordinary change first: once it shows, the events socket is live and
	// its opening refresh is behind us, so only an event can show the next one.
	await seedFile(student.workspaceId, project.slug, "probe.txt", "x\n");
	await expect(page.getByTestId("file-row-probe.txt")).toBeVisible({ timeout: 10_000 });

	await seedFile(student.workspaceId, project.slug, "node_modules/new.js", "x\n");
	await expect(page.getByTestId("file-row-node_modules/new.js")).toBeVisible({
		timeout: 10_000,
	});
});

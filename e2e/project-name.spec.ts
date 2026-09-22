import { expect, test } from "@playwright/test";
import { createProject, createStudent, workspacePath } from "./helpers";

/**
 * The projects pane shows the name only (issue #323, SPEC.md §7.1).
 * The directory slug stays where it names the folder: the status-bar path.
 */
test("the project list shows the name and not the directory slug", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, {
		name: "My First Project",
	});
	await page.goto(workspacePath(student.workspaceId, project.id));

	const row = page.getByTestId(`project-item-${project.id}`);
	await expect(row).toBeVisible();
	await expect(row).toContainText("My First Project");
	await expect(row).not.toContainText(project.slug);
	await expect(page.getByTestId(`project-slug-${project.id}`)).toHaveCount(0);

	await expect(page.getByTestId("status-bar")).toContainText(
		`~/projects/${project.slug}`,
	);
});

import { expect, test } from "@playwright/test";
import { createProject, createStudent, seedFile, workspacePath } from "./helpers";

// e2e cannot import @portikus/contracts; this is past its MAX_TREE_ENTRIES page.
const MORE_THAN_ONE_PAGE = 2003;

/** A directory past one listing page shows the rest on request (SPEC.md §11.2). */
test.describe("long directory listings", () => {
	test("Show more reaches the entries past the first page", async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Many" });
		const names = Array.from(
			{ length: MORE_THAN_ONE_PAGE },
			(_, index) => `f${String(index).padStart(5, "0")}.txt`,
		);
		// In batches, so the fake agent is not sent thousands of requests at once.
		for (let start = 0; start < names.length; start += 200) {
			await Promise.all(
				names
					.slice(start, start + 200)
					.map((name) => seedFile(student.workspaceId, project.slug, name, "")),
			);
		}
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId("file-tree")).toBeVisible({ timeout: 15_000 });

		const last = names.at(-1) ?? "";
		await expect(page.getByTestId("file-tree-truncated")).toBeVisible();
		await expect(page.getByTestId(`file-row-${last}`)).toHaveCount(0);

		await page.getByTestId("file-tree-show-more").click();
		await expect(page.getByTestId(`file-row-${last}`)).toHaveCount(1);
		await expect(page.getByTestId("file-tree-truncated")).toHaveCount(0);
	});
});

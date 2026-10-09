import { expect, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	seedFile,
	settledAxe,
	WCAG_TAGS,
	workspacePath,
} from "./helpers";

// e2e cannot import @portikus/contracts; this is past its MAX_TREE_ENTRIES page.
const MORE_THAN_ONE_PAGE = 2003;

/** A directory past one listing page shows the rest on request (SPEC.md §11.2, §25.8). */
test.describe("long directory listings", () => {
	test("Show more is a tree row the keyboard reaches, and focus lands on the new rows", async ({
		page,
		context,
	}) => {
		// Seeding 2,003 files and axe over a 2,000-row tree are slow on a shared runner.
		test.setTimeout(150_000);
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
		const more = page.getByTestId("file-tree-show-more");
		await expect(more).toHaveAttribute("role", "treeitem");
		await expect(page.getByTestId("file-tree-truncated")).toContainText(
			"2,000 entries shown",
		);
		await expect(page.getByTestId(`file-row-${last}`)).toHaveCount(0);

		const results = await (await settledAxe(page))
			.withTags(WCAG_TAGS)
			.include("[data-testid=file-tree]")
			.analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

		// Keyboard only: from the last loaded row, down to Show more, then Enter.
		await page.getByTestId("file-row-f01999.txt").focus();
		await page.keyboard.press("ArrowDown");
		await expect(more).toBeFocused();
		await expect(more).toContainText("Show 2,000 more…");
		// WCAG 2.4.7: the focused row draws a ring like every other row.
		const outline = await more
			.locator(".pk-tree-row")
			.evaluate((row) => getComputedStyle(row).outlineStyle);
		expect(outline).not.toBe("none");
		await page.keyboard.press("Enter");

		await expect(page.getByTestId("file-row-f02000.txt")).toBeFocused();
		await expect(page.getByTestId(`file-row-${last}`)).toHaveCount(1);
		await expect(more).toHaveCount(0);
		await expect(page.getByTestId("files-announcement")).toHaveText(
			"All 2,003 entries shown",
		);
	});
});

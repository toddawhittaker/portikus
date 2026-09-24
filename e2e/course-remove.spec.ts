/**
 * An instructor removes a member from the Course page, and a relaunch from
 * the LMS brings them back. Rex and Una in CS 350 belong to this spec alone.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { WEB_ORIGIN } from "./helpers";
import { launchAs, openCourseTab } from "./lti-helpers";

test("an instructor removes a student, who reappears after a relaunch", async ({
	browser,
}) => {
	const unaContext = await browser.newContext({ baseURL: WEB_ORIGIN });
	const rexContext = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		const una = await unaContext.newPage();
		await launchAs(una, { person: "una", course: "cs350" });

		const rex = await rexContext.newPage();
		await launchAs(rex, { person: "rex", course: "cs350" });
		const course = await openCourseTab(rex);
		const table = course.getByTestId("course-members");
		const unaRow = table.getByRole("row", { name: /Una Unenrolled/ });
		await expect(unaRow).toBeVisible();
		// Rex cannot remove himself.
		await expect(
			table.getByRole("button", { name: "Remove Rex Remover from course" }),
		).toHaveCount(0);

		await unaRow
			.getByRole("button", { name: "Remove Una Unenrolled from course" })
			.click();
		const dialog = course.getByTestId("dialog-remove-member");
		await expect(dialog).toContainText(
			"Remove Una Unenrolled from CS 350 Software Engineering?",
		);
		await expect(dialog).toContainText(
			"They reappear if they open Portikus from the course again.",
		);
		const axe = await new AxeBuilder({ page: course })
			.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
			.include('[data-testid="dialog-remove-member"]')
			.analyze();
		expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

		await dialog.getByRole("button", { name: "Remove from course" }).click();
		await expect(dialog).toBeHidden();
		await expect(unaRow).toHaveCount(0);
		await expect(course.getByTestId("course-removed")).toHaveText(
			"Removed Una Unenrolled from CS 350 Software Engineering",
		);
		// Nobody else can be removed, so focus lands on the page heading.
		await expect(course.getByRole("heading", { level: 1 })).toBeFocused();
		expect(await course.evaluate(() => document.activeElement === document.body)).toBe(
			false,
		);
		await course.reload();
		await expect(table.getByRole("row", { name: /Rex Remover/ })).toBeVisible();
		await expect(unaRow).toHaveCount(0);

		// Una opens Portikus from the course again, so the membership comes back.
		await launchAs(una, { person: "una", course: "cs350" });
		await course.reload();
		await expect(unaRow).toBeVisible();
	} finally {
		await unaContext.close();
		await rexContext.close();
	}
});

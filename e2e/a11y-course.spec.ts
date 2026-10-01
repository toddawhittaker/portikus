/**
 * Automated accessibility checks (SPEC.md section 25.8) on the Course page
 * and both LTI fallback pages (docs/archive/epics/EPIC-13.md rulings 17 and 24).
 */
import { expect, test } from "@playwright/test";
import { expectNoViolations, WEB_ORIGIN } from "./helpers";
import { launchAs, openCourseTab, startLaunch } from "./lti-helpers";

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Course page has no automatic accessibility violations (${colorScheme})`, async ({
		browser,
	}) => {
		const samContext = await browser.newContext({ baseURL: WEB_ORIGIN });
		await launchAs(await samContext.newPage(), { person: "sam", course: "cs240" });
		await samContext.close();

		const context = await browser.newContext({ baseURL: WEB_ORIGIN, colorScheme });
		try {
			const page = await context.newPage();
			await launchAs(page, { person: "tom", course: "cs240" });
			const course = await openCourseTab(page);
			const table = course.getByRole("table");
			await expect(table).toBeVisible();
			// The admin page's table and compact frame (SPEC.md section 20.1).
			await expect(table).toHaveClass("pk-table pk-table--page");
			await expect(course.getByTestId("page-course")).toHaveAttribute(
				"data-density",
				"compact",
			);
			await expect(course.getByTestId("intro-course")).toContainText(
				"they come back if they open Portikus from the course again",
			);
			// The intro explains Remove, so its column has no toggletip of its own.
			await expect(course.getByRole("button", { name: "About Remove" })).toHaveCount(0);
			await expectNoViolations(course);
		} finally {
			await context.close();
		}
	});
}

test("the open-in-a-new-tab page has no automatic accessibility violations", async ({
	page,
}) => {
	const inFrame = page.waitForResponse((r) =>
		r.url().startsWith(`${WEB_ORIGIN}/lti/login`),
	);
	await startLaunch(page, { person: "sam", frame: true });
	const response = await inFrame;
	const frame = response.frame();
	await expect(
		page
			.frameLocator('iframe[title="Portikus"]')
			.getByRole("button", { name: "Open Portikus in a new tab" }),
	).toBeVisible();
	// Check the fallback page on its own, as a top-level document would be.
	const html = await frame.content();
	const standalone = await page.context().newPage();
	await standalone.setContent(html);
	await expectNoViolations(standalone);
	await standalone.close();
});

test("the could-not-finish page has no automatic accessibility violations", async ({
	page,
}) => {
	await page.setContent(
		`<form method="post" action="${WEB_ORIGIN}/lti/launch">
		   <input type="hidden" name="id_token" value="not.a.token">
		   <input type="hidden" name="state" value="made-up-state">
		   <button type="submit">Post</button>
		 </form>`,
	);
	await page.getByRole("button", { name: "Post" }).click();
	await expect(page.getByText("Portikus could not finish opening here.")).toBeVisible();
	await expectNoViolations(page);
});

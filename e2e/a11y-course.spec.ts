/**
 * Automated accessibility checks (SPEC.md section 25.8) on the Course page
 * and both LTI fallback pages (ADR 0025).
 */
import { expect, type Page, test } from "@playwright/test";
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

/** A long display name with one long unbroken word, the worst case for a narrow table. */
const LONG_NAME =
	"Samantha Wolfeschlegelsteinhausenbergerdorffwelchevoralternwaren Student";

/** How far the page and the members table run past their boxes, in CSS pixels. */
async function sidewaysOverflow(course: Page) {
	return course.getByTestId("course-members").evaluate((table) => {
		const wrap = table.parentElement as HTMLElement;
		const main = table.closest("main") as HTMLElement;
		const root = document.documentElement;
		return {
			table: Math.max(
				0,
				Math.ceil(
					table.getBoundingClientRect().right - wrap.getBoundingClientRect().right,
				),
			),
			main: main.scrollWidth - main.clientWidth,
			page: root.scrollWidth - root.clientWidth,
		};
	});
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Course page fits a narrow window without scrolling sideways (${colorScheme})`, async ({
		browser,
	}) => {
		const context = await browser.newContext({
			baseURL: WEB_ORIGIN,
			colorScheme,
			viewport: { width: 768, height: 900 },
		});
		// A student with a long name joins the real roster in this context only;
		// renaming a seeded person would race the other LTI specs.
		await context.route(/\/courses\/[^/]+\/members$/, async (route) => {
			const response = await route.fetch();
			const body = (await response.json()) as { members: unknown[] };
			body.members.push({
				status: "active",
				userId: "00000000-0000-4000-8000-00000000c0de",
				displayName: LONG_NAME,
				role: "student",
				lastLaunchAt: new Date().toISOString(),
				workspaceState: "stopped",
			});
			await route.fulfill({ response, json: body });
		});
		try {
			const page = await context.newPage();
			await launchAs(page, { person: "tom", course: "cs240" });
			const course = await openCourseTab(page);
			const table = course.getByTestId("course-members");
			await expect(table).toBeVisible();
			const samRow = table.getByRole("row", { name: new RegExp(LONG_NAME) });

			// At 768 px every column still fits; the long name wraps instead.
			expect(await sidewaysOverflow(course)).toEqual({ table: 0, main: 0, page: 0 });
			for (const name of ["Name", "Role", "Last launch", "Workspace"]) {
				await expect(table.getByRole("columnheader", { name })).toBeVisible();
			}
			await expect(samRow.getByRole("button", { name: /Remove/ })).toBeVisible();
			await expectNoViolations(course);

			// Narrower, Role and Last launch fold under the name rather than scroll.
			await course.setViewportSize({ width: 480, height: 900 });
			await expect(table.getByRole("columnheader", { name: "Role" })).toBeHidden();
			await expect(
				table.getByRole("columnheader", { name: "Last launch" }),
			).toBeHidden();
			expect(await sidewaysOverflow(course)).toEqual({ table: 0, main: 0, page: 0 });
			// The row header is named by the name alone, so the other cells are not
			// announced with the folded role and launch as well.
			const samName = samRow.getByRole("rowheader", { name: LONG_NAME, exact: true });
			await expect(samName).toContainText("Student");
			await expect(samName).toContainText("Last launch");
			await expect(samName.locator("time")).toBeVisible();
			await expect(samRow.getByRole("button", { name: /Remove/ })).toBeVisible();
			await expectNoViolations(course);

			// At 320 px (400% zoom of a 1280 px window) nothing scrolls sideways either.
			await course.setViewportSize({ width: 320, height: 900 });
			expect(await sidewaysOverflow(course)).toEqual({ table: 0, main: 0, page: 0 });
			await expect(samName.locator("time")).toBeVisible();
			// Taller rows push it down the scrolling <main>, never off to the side.
			const remove = samRow.getByRole("button", { name: /Remove/ });
			await remove.scrollIntoViewIfNeeded();
			await expect(remove).toBeInViewport({ ratio: 1 });
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

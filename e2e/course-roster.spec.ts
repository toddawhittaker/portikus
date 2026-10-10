/**
 * Roster sync from the Course page (SPEC.md section 8.6, ADR 0058): people on
 * the learning system's roster who never opened Portikus show as Not started,
 * and a person dropped from the roster leaves the page after the next sync.
 * CS 330 and its instructor Roy belong to this spec alone, so its roster
 * changes cannot reach another spec's course.
 */
import { expect, test } from "@playwright/test";
import { WEB_ORIGIN } from "./helpers";
import { changeRoster, launchAs, openCourseTab } from "./lti-helpers";

test.describe.configure({ mode: "serial" });

test.afterEach(async ({ request }) => {
	// Undo only this spec's change; a full reset would undo other specs' drops.
	await changeRoster(request, { action: "add", course: "cs330", person: "lee" });
});

test("an instructor syncs the roster: roster-only people read Not started and a dropped member vanishes", async ({
	browser,
	request,
}) => {
	const leeContext = await browser.newContext({ baseURL: WEB_ORIGIN });
	const royContext = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		await launchAs(await leeContext.newPage(), { person: "lee", course: "cs330" });

		const roy = await royContext.newPage();
		await launchAs(roy, { person: "roy", course: "cs330" });
		const course = await openCourseTab(roy);
		const table = course.getByTestId("course-members");
		const status = course.getByTestId("roster-status");
		const leeRow = table.getByRole("row", { name: /Lee Learner/ });

		await course.getByRole("button", { name: "Sync roster" }).click();
		await expect(course.getByTestId("roster-sync")).toContainText("Roster synced:");
		await expect(status).toContainText("Last synced");
		await expect(status.locator("time")).toBeVisible();

		for (const name of [/Rosa Rosterly/, /Ned Notyet/]) {
			const row = table.getByRole("row", { name });
			await expect(row).toContainText("Not started");
			await expect(row).toContainText("Never");
			await expect(row.getByRole("button")).toHaveCount(0);
		}
		await expect(leeRow).toBeVisible();
		await expect(leeRow).not.toContainText("Not started");

		await changeRoster(request, { action: "drop", course: "cs330", person: "lee" });
		await course.getByRole("button", { name: "Sync roster" }).click();
		await expect(leeRow).toHaveCount(0);
		const announced = await course.getByTestId("roster-sync").textContent();
		expect(announced).toMatch(/^Roster synced: .* [1-9]\d* removed,/);
		await expect(table.getByRole("row", { name: /Rosa Rosterly/ })).toContainText(
			"Not started",
		);
	} finally {
		await leeContext.close();
		await royContext.close();
	}
});

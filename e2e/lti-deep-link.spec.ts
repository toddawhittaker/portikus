/**
 * LTI Deep Linking end to end against the mock LMS (ADR 0058, SPEC.md
 * §7.2, §25.8): an instructor picks in Portikus's picker, the signed link
 * is stored at the mock, and a student's launch of it lands on
 * `/?starter=<id>`. The web landing is covered by its own spec.
 */
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { query, settledAxe, WCAG_TAGS, WEB_ORIGIN } from "./helpers";
import { launchSavedLink, ltiUsers, signedIn, startDeepLinking } from "./lti-helpers";

const PICKER_HEADING = "Choose what this link opens";

async function openPicker(page: Page): Promise<void> {
	await startDeepLinking(page, { person: "ivy", course: "cs101" });
	await expect(page.getByRole("heading", { name: PICKER_HEADING })).toBeVisible({
		timeout: 30_000,
	});
}

async function expectNoAxeViolations(page: Page): Promise<void> {
	const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`the picker has no axe violations in ${colorScheme}`, async ({ page }) => {
		await page.emulateMedia({ colorScheme });
		await openPicker(page);
		await expectNoAxeViolations(page);

		// Shown again with its error, it still passes.
		await page.getByLabel("A public Git repository").check();
		await page.getByLabel("Repository URL").fill("ssh://git@example.com/repo.git");
		await page.getByRole("button", { name: "Add the link" }).click();
		await expect(page.getByText("must be a public https URL")).toBeVisible();
		await expectNoAxeViolations(page);
	});
}

test("the picker signs nobody in", async ({ page }) => {
	await openPicker(page);
	expect(await signedIn(page)).toBe(false);
	expect(await page.locator("script").count()).toBe(0);
});

test("a learner cannot open the picker", async ({ page }) => {
	await startDeepLinking(page, { person: "sam", course: "cs101" });
	await expect(
		page.getByRole("heading", { name: "Portikus could not open" }),
	).toBeVisible({
		timeout: 30_000,
	});
	expect(await signedIn(page)).toBe(false);
});

test("an instructor's pick returns to the course, and a student's launch of it lands on a starter", async ({
	page,
}) => {
	const title = `Lab ${randomUUID().slice(0, 8)}`;
	await openPicker(page);
	await page.getByLabel("Template: Starter").check();
	await page.getByLabel("Project name").fill(title);
	await page.getByRole("button", { name: "Add the link" }).click();

	await expect(page.getByRole("heading", { name: "Link ready" })).toBeVisible();
	await expectNoAxeViolations(page);
	await page.getByRole("button", { name: "Return to your course" }).click();
	await expect(page.getByRole("heading", { name: "Saved 1 link" })).toBeVisible();

	// The student's launch answers 303 to the starter; the landing UI is its own spec.
	const launched = page.waitForResponse(
		(res) =>
			res.url() === `${WEB_ORIGIN}/lti/launch` && res.request().method() === "POST",
	);
	await launchSavedLink(page, { title, person: "sam" });
	const location = (await launched).headers().location ?? "";
	const starterId = /^\/\?starter=([0-9a-f-]{36})$/.exec(location)?.[1];
	expect(starterId, location).toBeDefined();

	const [sam] = await ltiUsers("sam");
	const rows = await query<{ user_id: string; project_name: string; template: string }>(
		"select user_id, project_name, template from lti_starter_launches where id = $1",
		[starterId],
	);
	expect(rows).toEqual([
		{ user_id: sam?.id, project_name: title, template: "Starter" },
	]);
});

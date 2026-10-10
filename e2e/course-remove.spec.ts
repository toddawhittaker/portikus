/**
 * An instructor removes a member from the Course page, and a relaunch from
 * the LMS brings them back. Rex and Una in CS 350 belong to this spec alone.
 */
import { expect, test } from "@playwright/test";
import {
	createSignedInUser,
	query,
	settledAxe,
	WCAG_TAGS,
	WEB_ORIGIN,
} from "./helpers";
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
		const axe = await (await settledAxe(course))
			.withTags(WCAG_TAGS)
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

test("another instructor in the course has no Remove button", async ({ browser }) => {
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		// A course of its own with no roster address, so no sync drops the
		// co-teacher, who is made in the database and is on no LMS roster.
		const me = await createSignedInUser(context, "student");
		const tag = me.userId.slice(0, 8);
		const name = `Co Teacher ${tag}`;
		const [course] = await query<{ id: string }>(
			`insert into lti_contexts (platform_issuer, context_id, title, platform_name)
			 values ('e2e-coteach', $1, $2, 'E2E LMS') returning id`,
			[`coteach-${tag}`, `Co-teach ${tag}`],
		);
		if (!course) throw new Error("could not create the course");
		const [other] = await query<{ id: string }>(
			`insert into users (oidc_issuer, oidc_subject, email, display_name, role)
			 values ('e2e-coteach', $1, $2, $3, 'student') returning id`,
			[`coteach-${tag}`, `coteach-${tag}@example.edu`, name],
		);
		if (!other) throw new Error("could not create the co-teacher");
		await query(
			`insert into lti_memberships (context_id, user_id, role, last_launch_at)
			 values ($1, $2, 'instructor', now()), ($1, $3, 'instructor', now())`,
			[course.id, me.userId, other.id],
		);

		const page = await context.newPage();
		await page.goto(`/course/${course.id}`);
		const row = page
			.getByTestId("course-members")
			.getByRole("row", { name: new RegExp(name) });
		await expect(row).toBeVisible();
		await expect(row).toContainText("Instructor");
		await expect(row.getByRole("button")).toHaveCount(0);
	} finally {
		await context.close();
	}
});

test("Shift+Tab up a long course never hides the focused Remove under the header", async ({
	browser,
}) => {
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		// A course of its own, so the other tests here keep their members.
		const instructor = await createSignedInUser(context, "student");
		const tag = instructor.userId.slice(0, 8);
		const [course] = await query<{ id: string }>(
			`insert into lti_contexts (platform_issuer, context_id, title, platform_name)
			 values ('e2e-focus', $1, $2, 'E2E LMS') returning id`,
			[`focus-${tag}`, `Focus ${tag}`],
		);
		if (!course) throw new Error("could not create the course");
		await query(
			`insert into lti_memberships (context_id, user_id, role, last_launch_at)
			 values ($1, $2, 'instructor', now())`,
			[course.id, instructor.userId],
		);
		await query(
			`with made as (
			   insert into users (oidc_issuer, oidc_subject, email, display_name, role)
			   select 'e2e-focus', 'focus-' || $2 || '-' || n,
			          'focus-' || $2 || '-' || n || '@example.edu',
			          'Focus ' || $2 || ' ' || lpad(n::text, 2, '0'), 'student'
			   from generate_series(1, 40) as n
			   returning id)
			 insert into lti_memberships (context_id, user_id, role, last_launch_at)
			 select $1, id, 'student', now() from made`,
			[course.id, tag],
		);

		const page = await context.newPage();
		await page.setViewportSize({ width: 1280, height: 600 });
		await page.goto(`/course/${course.id}`);
		const table = page.getByTestId("course-members");
		const removes = table.getByRole("button", { name: /^Remove / });
		await expect(removes).toHaveCount(40, { timeout: 15_000 });

		await removes.last().focus();
		const header = table.locator("thead th").first();
		const firstId = await removes.first().getAttribute("data-remove-id");
		let checked = 0;
		let reachedTop = false;
		for (let step = 0; step < 200 && !reachedTop; step++) {
			await page.keyboard.press("Shift+Tab");
			const focused = await page.evaluate(() => {
				const el = document.activeElement as HTMLElement | null;
				const id = el?.getAttribute("data-remove-id");
				if (!el || !id) return null;
				const box = el.getBoundingClientRect();
				return { id, top: box.top, bottom: box.bottom };
			});
			if (focused === null) continue;
			const headerBox = await header.boundingBox();
			const mainBox = await page.getByTestId("page-course").boundingBox();
			if (!headerBox || !mainBox) throw new Error("the header or main has no box");
			// Fully visible: below the sticky header and above the bottom of <main>.
			expect(focused.top).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
			expect(focused.bottom).toBeLessThanOrEqual(mainBox.y + mainBox.height + 1);
			checked++;
			reachedTop = focused.id === firstId;
		}
		expect(reachedTop).toBe(true);
		expect(checked).toBeGreaterThanOrEqual(39);
	} finally {
		await context.close();
	}
});

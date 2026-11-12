import {
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import {
	createProject,
	createSignedInUser,
	createStudent,
	expectConnected,
	newTerminal,
	query,
	settledAxe,
	terminalIds,
	WCAG_TAGS,
	WEB_ORIGIN,
	workspacePath,
} from "./helpers";

/**
 * Automated accessibility checks (SPEC.md section 25.8) on the redesigned
 * live help pages (ADR 0063): the instructor's queue and an open session
 * with its terminal, in both themes, on a desktop and on a phone, where the
 * "Request and previews" disclosure starts folded and is checked unfolded too.
 */

/** Axe in one theme, naming each rule with the elements that break it. */
async function scan(page: Page, colorScheme: "light" | "dark"): Promise<void> {
	await page.emulateMedia({ colorScheme });
	const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
	const found = results.violations.map(
		(v) =>
			`${colorScheme} ${v.id}: ${v.help} [${v.nodes.map((n) => n.target.join(" ")).join(", ")}]`,
	);
	expect(found).toEqual([]);
}

async function scanBothThemes(page: Page): Promise<void> {
	await scan(page, "dark");
	await scan(page, "light");
}

/** A course with one instructor and the student, seeded for this test alone. */
async function courseWith(studentId: string, instructorId: string): Promise<string> {
	const tag = instructorId.slice(0, 8);
	const [course] = await query<{ id: string }>(
		`insert into lti_contexts (platform_issuer, context_id, title, platform_name)
		 values ('e2e-live-help-a11y', $1, $2, 'E2E LMS') returning id`,
		[`live-a11y-${tag}`, `Live ${tag}`],
	);
	if (!course) throw new Error("could not create the course");
	await query(
		`insert into lti_memberships (context_id, user_id, role, last_launch_at)
		 values ($1, $2, 'instructor', now()), ($1, $3, 'student', now())`,
		[course.id, instructorId, studentId],
	);
	return course.id;
}

/**
 * A student with a terminal open who has asked their instructor for live
 * help, and the instructor signed in on a page of their own.
 */
async function openRequest(
	page: Page,
	context: BrowserContext,
	browser: Browser,
	viewport: { width: number; height: number },
): Promise<{ instructor: Page; instructorContext: BrowserContext; courseId: string }> {
	const student = await createStudent(context);
	await query("update users set display_name = 'Ada Student' where id = $1", [
		student.userId,
	]);
	const project = await createProject(student.workspaceId, { name: "Live Work" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await newTerminal(page);
	// The terminal's row exists once its tab shows.
	await expect(page.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
	const [terminalId] = await terminalIds(student.workspaceId);
	if (!terminalId) throw new Error("the terminal row was not created");
	await expectConnected(page, terminalId);

	const instructorContext = await browser.newContext({ baseURL: WEB_ORIGIN, viewport });
	const instructor = await createSignedInUser(instructorContext, "student");
	await query("update users set display_name = 'Ivy Instructor' where id = $1", [
		instructor.userId,
	]);
	const courseId = await courseWith(student.userId, instructor.userId);
	const started = await page.request.post(
		`/workspaces/${student.workspaceId}/projects/${project.id}/live-help`,
		{
			headers: { origin: WEB_ORIGIN },
			data: { helperUserId: instructor.userId, courseId },
		},
	);
	expect(started.status()).toBe(200);
	return { instructor: await instructorContext.newPage(), instructorContext, courseId };
}

/** The queue, then the open session, as the instructor reaches them from the Course page. */
async function queueThenSession(instructor: Page, courseId: string) {
	await instructor.goto(`/course/${courseId}`);
	await instructor.getByTestId("course-live-help").click();
	const table = instructor.getByTestId("live-sessions");
	await expect(table.getByRole("rowheader", { name: "Ada Student" })).toBeVisible({
		timeout: 15_000,
	});
	await scanBothThemes(instructor);

	await table
		.getByRole("link", { name: "Open live help with Ada Student on Live Work" })
		.click();
	await expect(instructor.getByRole("heading", { level: 1 })).toHaveText(
		"Live help with Ada Student",
	);
	await expect(instructor.getByTestId("helper-terminal")).toHaveAttribute(
		"data-connected",
		"true",
		{ timeout: 15_000 },
	);
}

test("the live help queue and session have no automatic violations on a desktop", async ({
	page,
	context,
	browser,
}) => {
	const { instructor, instructorContext, courseId } = await openRequest(
		page,
		context,
		browser,
		{ width: 1280, height: 900 },
	);
	try {
		await queueThenSession(instructor, courseId);
		// Beside the terminal, the request starts open.
		const details = instructor.locator("details", {
			has: instructor.locator("summary", { hasText: "Request and previews" }),
		});
		await expect(details).toHaveAttribute("open", "");
		await scanBothThemes(instructor);
	} finally {
		await instructorContext.close();
	}
});

test("the live help queue and session have no automatic violations on a phone, folded and unfolded", async ({
	page,
	context,
	browser,
}) => {
	const { instructor, instructorContext, courseId } = await openRequest(
		page,
		context,
		browser,
		{ width: 390, height: 844 },
	);
	try {
		await queueThenSession(instructor, courseId);
		const summary = instructor.locator("summary", { hasText: "Request and previews" });
		const details = instructor.locator("details", { has: summary });
		await expect(details).not.toHaveAttribute("open");
		await scanBothThemes(instructor);

		await summary.click();
		await expect(details).toHaveAttribute("open", "");
		await expect(instructor.getByRole("heading", { name: "Previews" })).toBeVisible();
		await scanBothThemes(instructor);
	} finally {
		await instructorContext.close();
	}
});

/**
 * A student shares one project with their instructors (SPEC.md section 5.2):
 * the dialog says who sees what, a viewer appears once an instructor reads,
 * Stop sharing and the 24-hour expiry end it, and the dialog passes axe.
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createSignedInUser,
	createStudent,
	expectNoViolations,
	query,
	seedFile,
	WEB_ORIGIN,
	workspacePath,
} from "./helpers";

async function openShare(page: Page, projectId: string) {
	await page.getByTestId(`project-menu-${projectId}`).click();
	await page.getByRole("menuitem", { name: "Share with my instructors…" }).click();
	const dialog = page.getByTestId("dialog-share-project");
	await expect(dialog).toBeVisible();
	return dialog;
}

/** A course with one instructor and the student, for the instructor's read route. */
async function courseWith(studentId: string, instructorId: string): Promise<string> {
	const tag = instructorId.slice(0, 8);
	const [course] = await query<{ id: string }>(
		`insert into lti_contexts (platform_issuer, context_id, title, platform_name)
		 values ('e2e-share', $1, $2, 'E2E LMS') returning id`,
		[`share-${tag}`, `Share ${tag}`],
	);
	if (!course) throw new Error("could not create the course");
	await query(
		`insert into lti_memberships (context_id, user_id, role, last_launch_at)
		 values ($1, $2, 'instructor', now()), ($1, $3, 'student', now())`,
		[course.id, instructorId, studentId],
	);
	return course.id;
}

test("start, see a viewer after an instructor reads, then stop", async ({
	page,
	context,
	browser,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Share Me" });
	await seedFile(student.workspaceId, project.slug, "main.py", "print('hi')\n");
	await page.goto(workspacePath(student.workspaceId, project.id));

	const dialog = await openShare(page, project.id);
	await expect(dialog.getByTestId("share-terms")).toContainText(
		"The instructors of the courses you belong to",
	);
	await expect(dialog.getByTestId("share-terms")).toContainText("Never");
	await expect(dialog.getByTestId("share-audience")).toContainText(
		"You are in no course yet",
	);
	await expect(dialog.getByTestId("share-time")).toHaveText(
		"24 hours, or until you stop it.",
	);
	await expect(dialog.getByTestId("share-stop")).toHaveCount(0);

	await dialog.getByTestId("share-start").click();
	await expect(dialog.getByTestId("share-stop")).toBeVisible();
	await expect(dialog.getByTestId("share-status")).toContainText("Sharing until");
	await expect(dialog.getByTestId("share-time")).toContainText("24 hours left");
	await expect(dialog.getByTestId("share-no-viewers")).toBeVisible();

	// The instructor reads the project through the course route.
	const instructorContext = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		const instructor = await createSignedInUser(instructorContext, "student");
		await query("update users set display_name = 'Ivy Instructor' where id = $1", [
			instructor.userId,
		]);
		const courseId = await courseWith(student.userId, instructor.userId);
		const read = await instructorContext.request.get(
			`/courses/${courseId}/shares/${project.id}/tree?path=`,
		);
		expect(read.status()).toBe(200);
	} finally {
		await instructorContext.close();
	}

	// The dialog polls, so the viewer shows up without reopening it.
	await expect(dialog.getByTestId("share-viewers")).toContainText(
		"Ivy Instructor, last looked",
		{ timeout: 30_000 },
	);

	await dialog.getByTestId("share-stop").click();
	await expect(dialog.getByTestId("share-start")).toBeVisible();
	await expect(dialog.getByTestId("share-status")).toHaveText("Sharing stopped.");
	await expect(dialog.getByTestId("share-viewers")).toHaveCount(0);
	const [row] = await query<{ ended_at: string | null }>(
		"select ended_at from project_shares where project_id = $1",
		[project.id],
	);
	expect(row?.ended_at).not.toBeNull();
});

test("before Start sharing the dialog names each course and its instructors", async ({
	page,
	context,
	browser,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Audience" });
	const instructorContext = await browser.newContext({ baseURL: WEB_ORIGIN });
	let courseTitle: string;
	try {
		const instructor = await createSignedInUser(instructorContext, "student");
		await query("update users set display_name = 'Ivy Teacher' where id = $1", [
			instructor.userId,
		]);
		const courseId = await courseWith(student.userId, instructor.userId);
		const [course] = await query<{ title: string }>(
			"select title from lti_contexts where id = $1",
			[courseId],
		);
		courseTitle = course?.title ?? "";
	} finally {
		await instructorContext.close();
	}
	await page.goto(workspacePath(student.workspaceId, project.id));

	const dialog = await openShare(page, project.id);
	await expect(dialog.getByTestId("share-audience").getByRole("listitem")).toHaveText([
		`${courseTitle}: Ivy Teacher`,
	]);
	await expect(dialog.getByTestId("share-start")).toBeVisible();
});

test("a shared project has a Shared tag until the share ends", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Tagged" });
	const other = await createProject(student.workspaceId, { name: "Private" });
	await page.goto(workspacePath(student.workspaceId, project.id));

	const dialog = await openShare(page, project.id);
	await dialog.getByTestId("share-start").click();
	await expect(dialog.getByTestId("share-stop")).toBeVisible();
	await dialog.getByRole("button", { name: "Close" }).first().click();

	await expect(page.getByTestId(`project-shared-${project.id}`)).toHaveText("Shared");
	await expect(page.getByTestId(`project-shared-${other.id}`)).toHaveCount(0);

	// 24 hours pass: the share is over and the tag goes with it.
	await query(
		"update project_shares set started_at = now() - interval '25 hours', ends_at = now() - interval '1 minute' where project_id = $1",
		[project.id],
	);
	await page.reload();
	await expect(page.getByTestId(`project-item-${project.id}`)).toBeVisible();
	await expect(page.getByTestId(`project-shared-${project.id}`)).toHaveCount(0);

	// Sharing again works once the expired share is closed.
	const again = await openShare(page, project.id);
	await expect(again.getByTestId("share-start")).toBeVisible();
	await again.getByTestId("share-start").click();
	await expect(again.getByTestId("share-stop")).toBeVisible();
});

test("archiving a shared project ends the share, and unarchiving does not restart it", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Finished" });
	const other = await createProject(student.workspaceId, { name: "Current" });
	await page.goto(workspacePath(student.workspaceId, other.id));

	const dialog = await openShare(page, project.id);
	await dialog.getByTestId("share-start").click();
	await expect(dialog.getByTestId("share-stop")).toBeVisible();
	await dialog.getByRole("button", { name: "Close" }).first().click();
	await expect(page.getByTestId(`project-shared-${project.id}`)).toHaveText("Shared");

	await page.getByTestId(`project-menu-${project.id}`).click();
	await page.getByRole("menuitem", { name: "Archive" }).click();
	await page.getByTestId("dialog-confirm").click();
	await expect(page.getByTestId(`project-item-${project.id}`)).toHaveCount(0);

	await page.getByTestId("archived-projects").click();
	await page.getByTestId(`project-unarchive-${project.id}`).click();
	await expect
		.poll(async () => {
			const rows = await query<{ state: string }>(
				"select state from projects where id = $1",
				[project.id],
			);
			return rows[0]?.state;
		})
		.toBe("active");

	await page.goto(workspacePath(student.workspaceId, other.id));
	await expect(page.getByTestId(`project-item-${project.id}`)).toBeVisible();
	await expect(page.getByTestId(`project-shared-${project.id}`)).toHaveCount(0);
	const reopened = await openShare(page, project.id);
	await expect(reopened.getByTestId("share-start")).toBeVisible();
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`the share dialog has no axe violations (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Axe Me" });
		await page.goto(workspacePath(student.workspaceId, project.id));

		const dialog = await openShare(page, project.id);
		await expect(dialog.getByTestId("share-start")).toBeVisible();
		await expectNoViolations(page, "[data-testid=dialog-share-project]");

		await dialog.getByTestId("share-start").click();
		await expect(dialog.getByTestId("share-no-viewers")).toBeVisible();
		await expectNoViolations(page, "[data-testid=dialog-share-project]");
	});
}

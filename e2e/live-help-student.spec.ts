/**
 * A student asks one instructor for live help on one project (ADR 0063): the
 * dialog says what the instructor sees and what typing gives them before
 * anything starts, the bar across the workspace names them and switches
 * typing, End closes it, and refusals read plainly. Axe runs in both themes,
 * and the whole flow works from the keyboard alone.
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	DEX_ACCOUNT_ISSUER,
	expectNoViolations,
	query,
	WEB_ORIGIN,
	workspacePath,
} from "./helpers";

/** An instructor who never signs in: the student only names them. */
async function instructor(displayName: string): Promise<string> {
	const subject = `e2e-${crypto.randomUUID()}`;
	const [user] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role)
		 values ($1, $2, $3, $4, 'student') returning id`,
		[DEX_ACCOUNT_ISSUER, subject, `${subject}@example.edu`, displayName],
	);
	if (!user) throw new Error("could not create the instructor");
	return user.id;
}

/** A course the student belongs to, taught by `instructorId`. */
async function courseWith(studentId: string, instructorId: string): Promise<string> {
	const tag = instructorId.slice(0, 8);
	const [course] = await query<{ id: string }>(
		`insert into lti_contexts (platform_issuer, context_id, title, platform_name)
		 values ('e2e-live-help', $1, $2, 'E2E LMS') returning id`,
		[`live-${tag}`, `Live ${tag}`],
	);
	if (!course) throw new Error("could not create the course");
	await query(
		`insert into lti_memberships (context_id, user_id, role, last_launch_at)
		 values ($1, $2, 'instructor', now()), ($1, $3, 'student', now())`,
		[course.id, instructorId, studentId],
	);
	return course.id;
}

async function openStart(page: Page, projectId: string) {
	await page.getByTestId(`project-menu-${projectId}`).click();
	await page.getByRole("menuitem", { name: "Get live help…" }).click();
	const dialog = page.getByTestId("dialog-live-help");
	await expect(dialog).toBeVisible();
	return dialog;
}

async function openRow(workspaceId: string) {
	return query<{ typing: boolean; ended_at: string | null; helper_user_id: string }>(
		"select typing, ended_at, helper_user_id from live_help_sessions where workspace_id = $1",
		[workspaceId],
	);
}

test("start with consent, let them type, stop typing, then End", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Help Me" });
	const ivy = await instructor("Ivy Helper");
	await courseWith(student.userId, ivy);
	await page.goto(workspacePath(student.workspaceId, project.id));

	const dialog = await openStart(page, project.id);
	await expect(
		dialog.getByRole("heading", { name: "Get live help on Help Me" }),
	).toBeVisible();
	// The only instructor is chosen already.
	await expect(dialog.getByRole("combobox", { name: /Who should help/ })).toContainText(
		"Ivy Helper",
	);
	const terms = dialog.getByTestId("live-help-terms");
	await expect(terms).toContainText("The terminals of Help Me and its previews");
	await expect(terms).toContainText("Off. They can only watch");
	await expect(terms).toContainText("Only you can turn typing on or off");
	await expect(dialog.getByTestId("live-help-typing-risk")).toContainText(
		"full shell as you. That includes your Git, Claude and SSH credentials",
	);
	await expect(dialog.getByTestId("live-help-typing-risk")).toContainText(
		"your other terminals",
	);
	await expect(terms).toContainText("At most 60 minutes");
	// Nothing starts until the student presses Start.
	expect(await openRow(student.workspaceId)).toEqual([]);

	await dialog.getByTestId("live-help-start").click();
	await expect(dialog).toBeHidden();
	const bar = page.getByTestId("live-help-bar");
	await expect(
		bar.getByRole("heading", { name: "Live help with Ivy Helper" }),
	).toBeVisible();
	await expect(bar).toContainText(
		"They can see the terminals and previews of Help Me.",
	);
	await expect(bar).toContainText("They cannot type.");
	await expect(page.getByTestId("live-help-time")).toHaveText(
		/^(59|60) minutes left$|^1 hour left$/,
	);
	await expect(page.getByTestId("live-help-announce")).toHaveText(
		"Live help started. Ivy Helper can see the terminals and previews of Help Me. Typing is off.",
	);
	const [started] = await openRow(student.workspaceId);
	expect(started).toMatchObject({ typing: false, ended_at: null, helper_user_id: ivy });

	await bar.getByRole("button", { name: "Let them type" }).click();
	await expect(bar.getByRole("button", { name: "Stop typing" })).toBeVisible();
	await expect(bar).toContainText("They can type in them, with a full shell as you.");
	await expect(page.getByTestId("live-help-announce")).toHaveText(
		"Ivy Helper can now type in your terminals.",
	);
	expect((await openRow(student.workspaceId))[0]?.typing).toBe(true);

	await bar.getByRole("button", { name: "Stop typing" }).click();
	await expect(bar.getByRole("button", { name: "Let them type" })).toBeVisible();
	await expect(page.getByTestId("live-help-announce")).toHaveText(
		"Ivy Helper can no longer type. They can only watch.",
	);
	expect((await openRow(student.workspaceId))[0]?.typing).toBe(false);

	await bar.getByRole("button", { name: "End live help" }).click();
	await expect(bar).toBeHidden();
	await expect(page.getByTestId("live-help-announce")).toHaveText(
		"You ended live help with Ivy Helper.",
	);
	expect((await openRow(student.workspaceId))[0]?.ended_at).not.toBeNull();
	// Focus does not fall to the page when the bar goes.
	await expect(page.getByRole("main", { name: "Work area" })).toBeFocused();
});

test("an end from the instructor's side reaches the bar within a poll", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Ends Elsewhere" });
	const ivy = await instructor("Ivy Leaver");
	await courseWith(student.userId, ivy);
	await page.goto(workspacePath(student.workspaceId, project.id));
	const dialog = await openStart(page, project.id);
	await dialog.getByTestId("live-help-start").click();
	await expect(page.getByTestId("live-help-bar")).toBeVisible();

	// The same row change the instructor's Leave makes.
	await query(
		"update live_help_sessions set ended_at = now() where workspace_id = $1 and ended_at is null",
		[student.workspaceId],
	);
	await expect(page.getByTestId("live-help-bar")).toBeHidden({ timeout: 10_000 });
	await expect(page.getByTestId("live-help-announce")).toHaveText(
		"Live help with Ivy Leaver ended. They left, the project was archived, or they no longer teach your course.",
	);
});

test("a second session is refused plainly while one is open", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const first = await createProject(student.workspaceId, { name: "First" });
	const second = await createProject(student.workspaceId, { name: "Second" });
	const ivy = await instructor("Ivy Busy");
	const courseId = await courseWith(student.userId, ivy);
	await page.goto(workspacePath(student.workspaceId, second.id));

	// The dialog is already open when another browser starts a session.
	const dialog = await openStart(page, second.id);
	await expect(dialog.getByTestId("live-help-start")).toBeVisible();
	const elsewhere = await page.request.post(
		`/workspaces/${student.workspaceId}/projects/${first.id}/live-help`,
		{ headers: { origin: WEB_ORIGIN }, data: { helperUserId: ivy, courseId } },
	);
	expect(elsewhere.status()).toBe(200);

	await dialog.getByTestId("live-help-start").click();
	await expect(dialog.getByTestId("live-help-already-open")).toHaveText(
		"Live help with Ivy Busy on First is already open. End it from the bar at the top of the page before you start another.",
	);
	await expect(dialog.getByTestId("live-help-start")).toHaveCount(0);
	await dialog.getByRole("button", { name: "Close" }).first().click();
	await expect(page.getByTestId("live-help-bar")).toContainText("previews of First");
});

test("an instructor who stopped teaching the course is refused with what to do next", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Refused" });
	const ivy = await instructor("Ivy Gone");
	const courseId = await courseWith(student.userId, ivy);
	await page.goto(workspacePath(student.workspaceId, project.id));
	const dialog = await openStart(page, project.id);
	await expect(dialog.getByTestId("live-help-start")).toBeVisible();

	await query("delete from lti_memberships where context_id = $1 and user_id = $2", [
		courseId,
		ivy,
	]);
	await dialog.getByTestId("live-help-start").click();
	await expect(dialog.getByTestId("dialog-error")).toContainText(
		"That person does not teach that course of yours. The list has been read again; choose an instructor from it.",
	);
	await expect(dialog.getByTestId("dialog-error")).toContainText("VALIDATION_FAILED");
	// The list is read again and now has no one in it.
	await expect(dialog.getByTestId("live-help-no-instructors")).toBeVisible();
	await expect(page.getByTestId("live-help-bar")).toHaveCount(0);
});

test("a student in no course with an instructor is told there is no one to ask", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Alone" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	const dialog = await openStart(page, project.id);
	await expect(dialog.getByTestId("live-help-no-instructors")).toContainText(
		"there is no one to ask",
	);
	await expect(dialog.getByTestId("live-help-start")).toHaveCount(0);
});

test("the whole flow works from the keyboard alone", async ({ page, context }) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Keys" });
	const ivy = await instructor("Ivy Keys");
	await courseWith(student.userId, ivy);
	await page.goto(workspacePath(student.workspaceId, project.id));

	await page.getByTestId(`project-menu-${project.id}`).focus();
	await page.keyboard.press("Enter");
	const item = page.getByRole("menuitem", { name: "Get live help…" });
	await expect(item).toBeVisible();
	while (!(await item.evaluate((node) => node === document.activeElement))) {
		await page.keyboard.press("ArrowDown");
	}
	await page.keyboard.press("Enter");
	const dialog = page.getByTestId("dialog-live-help");
	await expect(dialog).toBeVisible();
	const start = dialog.getByTestId("live-help-start");
	for (
		let step = 0;
		step < 10 && !(await start.evaluate((n) => n === document.activeElement));
		step++
	) {
		await page.keyboard.press("Tab");
	}
	await expect(start).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(dialog).toBeHidden();

	const typing = page.getByTestId("live-help-typing");
	await typing.focus();
	await page.keyboard.press("Enter");
	await expect(typing).toHaveText("Stop typing");
	await expect(typing).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(page.getByTestId("live-help-end")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("live-help-bar")).toBeHidden();
	await expect(page.getByRole("main", { name: "Work area" })).toBeFocused();
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`the dialog and the bar have no automatic accessibility violations (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Axe" });
		const ivy = await instructor("Ivy Axe");
		await courseWith(student.userId, ivy);
		await page.goto(workspacePath(student.workspaceId, project.id));

		const dialog = await openStart(page, project.id);
		await expect(dialog.getByTestId("live-help-terms")).toBeVisible();
		await expectNoViolations(page, '[data-testid="dialog-live-help"]');

		await dialog.getByTestId("live-help-start").click();
		const bar = page.getByTestId("live-help-bar");
		await expect(bar).toBeVisible();
		await expectNoViolations(page, '[data-testid="live-help-bar"]');
		// The typing state has its own fill, so it is scanned too.
		await bar.getByRole("button", { name: "Let them type" }).click();
		await expect(bar.getByRole("button", { name: "Stop typing" })).toBeVisible();
		await expectNoViolations(page, '[data-testid="live-help-bar"]');
		await expectNoViolations(page);
	});
}

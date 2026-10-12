/**
 * The instructor's side of live help (ADR 0063): the student opens a
 * session, the instructor finds it from the Course page and sees the
 * student's terminal; view mode refuses input, typing reaches the shell once
 * the student allows it, a stopped workspace reads as the student being
 * away, ending the session closes the instructor's view at once, and a
 * preview of what the workspace serves opens in a new tab. The student's
 * side is driven through its API here; its own spec covers the bar.
 *
 * The fake workspace agent echoes every frame it is sent back as output,
 * prefixed with "echo:", to every attachment of the terminal.
 */
import {
	type APIResponse,
	type BrowserContext,
	expect,
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import {
	createProject,
	createSignedInUser,
	createStudent,
	expectConnected,
	expectNoViolations,
	newTerminal,
	query,
	setWorkspaceState,
	startPreviewApp,
	terminalIds,
	WEB_ORIGIN,
	workspacePath,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";
import { previewGateway } from "./preview-gateway";

/** The suffix of every preview host the end-to-end API names. */
const PREVIEW_SUFFIX = ".preview.localhost";

/** Axe in the light theme, then the dark, leaving the page light again. */
async function expectNoViolationsInBothThemes(page: Page): Promise<void> {
	await page.emulateMedia({ colorScheme: "light" });
	await expectNoViolations(page);
	await page.emulateMedia({ colorScheme: "dark" });
	await expectNoViolations(page);
	await page.emulateMedia({ colorScheme: "light" });
}

/** A course with one instructor and the student, seeded for this test alone. */
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

function post(page: Page, path: string, data?: unknown): Promise<APIResponse> {
	return page.request.post(path, { headers: { origin: WEB_ORIGIN }, data });
}

/** Every frame the fake agent was sent, as text. */
async function received(): Promise<string[]> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/received`);
	const body = (await response.json()) as { received: { text: string }[] };
	return body.received.map((frame) => frame.text);
}

/** Type into a terminal's screen and press Enter. */
async function typeInto(page: Page, screen: Locator, text: string): Promise<void> {
	await screen.click();
	await page.keyboard.insertText(text);
	await page.keyboard.press("Enter");
}

/**
 * Type until the text shows in `rows`. Keystrokes sent before an attach
 * finishes opening are dropped, as for any terminal.
 */
async function typeUntilShown(
	page: Page,
	screen: Locator,
	rows: Locator,
	text: string,
): Promise<void> {
	await expect
		.poll(
			async () => {
				const seen = (await rows.textContent()) ?? "";
				if (seen.includes(text)) return seen;
				await typeInto(page, screen, text);
				await page.waitForTimeout(500);
				return (await rows.textContent()) ?? "";
			},
			{ timeout: 20_000, intervals: [200, 500, 1000, 2000] },
		)
		.toContain(text);
}

interface Setup {
	student: Page;
	instructor: Page;
	instructorContext: BrowserContext;
	workspaceId: string;
	projectId: string;
	terminalId: string;
	courseId: string;
}

/** A student with a project and a terminal open, and their instructor signed in. */
async function setUp(
	page: Page,
	context: BrowserContext,
	browser: import("@playwright/test").Browser,
): Promise<Setup> {
	const student = await createStudent(context);
	await query("update users set display_name = 'Ada Student' where id = $1", [
		student.userId,
	]);
	const project = await createProject(student.workspaceId, { name: "Live Work" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await newTerminal(page);
	await expect(page.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
	const [terminalId] = await terminalIds(student.workspaceId);
	if (!terminalId) throw new Error("the terminal row was not created");
	await expectConnected(page, terminalId);

	const instructorContext = await browser.newContext({ baseURL: WEB_ORIGIN });
	const instructor = await createSignedInUser(instructorContext, "student");
	await query("update users set display_name = 'Ivy Instructor' where id = $1", [
		instructor.userId,
	]);
	const courseId = await courseWith(student.userId, instructor.userId);
	const started = await post(
		page,
		`/workspaces/${student.workspaceId}/projects/${project.id}/live-help`,
		{ helperUserId: instructor.userId, courseId },
	);
	expect(started.status()).toBe(200);
	return {
		student: page,
		instructor: await instructorContext.newPage(),
		instructorContext,
		workspaceId: student.workspaceId,
		projectId: project.id,
		terminalId,
		courseId,
	};
}

/** From the Course page to the session's view, as an instructor gets there. */
async function openSession(setup: Setup): Promise<Locator> {
	const page = setup.instructor;
	await page.goto(`/course/${setup.courseId}`);
	const link = page.getByTestId("course-live-help");
	await expect(link).toBeVisible();
	await expect(page.getByText("1 open session")).toBeVisible();
	await expectNoViolationsInBothThemes(page);
	await link.click();
	const table = page.getByTestId("live-sessions");
	await expect(table.getByRole("rowheader", { name: "Ada Student" })).toBeVisible();
	await expect(table).toContainText("Live Work");
	await expect(table).toContainText("Viewing only");
	await expectNoViolationsInBothThemes(page);
	await table
		.getByRole("link", { name: "Open live help with Ada Student on Live Work" })
		.click();
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		"Live help with Ada Student",
	);
	const terminal = page.getByTestId("helper-terminal");
	await expect(terminal).toHaveAttribute("data-connected", "true", { timeout: 15_000 });
	return terminal;
}

test("the instructor watches, cannot type until allowed, then types, and End closes the view", async ({
	page,
	context,
	browser,
}) => {
	const setup = await setUp(page, context, browser);
	try {
		const instructor = setup.instructor;
		const terminal = await openSession(setup);
		const helperRows = terminal.locator(".xterm-rows");
		const helperScreen = terminal.locator(".xterm-screen");
		const studentPane = page.getByTestId(`terminal-pane-${setup.terminalId}`);
		const studentRows = studentPane.locator(".xterm-rows");
		const studentScreen = studentPane.locator(".xterm-screen");

		const mode = instructor.getByTestId("live-mode");
		await expect(mode).toHaveAttribute("data-mode", "view");
		await expect(mode).toContainText("Viewing only.");
		await expect(terminal).toHaveAttribute("data-mode", "view");

		// What the student types shows in the instructor's view.
		await typeUntilShown(page, studentScreen, studentRows, "from-student");
		await expect(helperRows).toContainText("from-student");

		// In view mode the instructor's keystrokes never reach the agent.
		await typeInto(instructor, helperScreen, "from-helper-view");
		await instructor.waitForTimeout(1000);
		expect((await received()).some((text) => text.includes("from-helper-view"))).toBe(
			false,
		);
		await expect(studentRows).not.toContainText("from-helper-view");

		// The scroll box is a named stop of its own, and in view mode Tab
		// leaves the terminal rather than being swallowed by it.
		await expect(
			instructor.getByRole("region", { name: "Terminal Terminal 1, scrollable" }),
		).toBeVisible();
		await expect(
			instructor.getByText("Alt+Shift+Q leaves the terminal."),
		).toBeVisible();
		const helperInput = terminal.locator("textarea");
		await helperInput.focus();
		await instructor.keyboard.press("Tab");
		await expect(helperInput).not.toBeFocused();

		await expectNoViolationsInBothThemes(instructor);

		// The student lets them type; the view reconnects in type mode, with
		// the keyboard still in the terminal.
		await helperInput.focus();
		const typing = await post(
			page,
			`/workspaces/${setup.workspaceId}/live-help/typing`,
			{
				typing: true,
			},
		);
		expect(typing.status()).toBe(200);
		await expect(mode).toHaveAttribute("data-mode", "type");
		await expect(mode).toContainText("Typing allowed.");
		await expect(terminal).toHaveAttribute("data-mode", "type");
		await expect(terminal).toHaveAttribute("data-connected", "true", {
			timeout: 15_000,
		});
		await expect(helperInput).toBeFocused();

		await typeUntilShown(instructor, helperScreen, studentRows, "from-helper-type");
		expect((await received()).some((text) => text.includes("from-helper-type"))).toBe(
			true,
		);
		await expectNoViolationsInBothThemes(instructor);

		// The student ends the session: the instructor's view closes within a second.
		const stopped = await post(page, `/workspaces/${setup.workspaceId}/live-help/stop`);
		expect(stopped.status()).toBe(200);
		await expect(instructor.getByTestId("live-ended")).toBeVisible({ timeout: 1_000 });
		await expect(instructor.getByTestId("helper-terminal")).toHaveCount(0);
		await expect(instructor.getByTestId("live-session-status")).toHaveText(
			"This live help session has ended.",
		);
		await expectNoViolations(instructor);
	} finally {
		await setup.instructorContext.close();
	}
});

test("a stopped workspace reads as the student being away, and the view comes back", async ({
	page,
	context,
	browser,
}) => {
	const setup = await setUp(page, context, browser);
	try {
		const instructor = setup.instructor;
		await openSession(setup);

		await setWorkspaceState(setup.workspaceId, "stopped");
		const away = instructor.getByTestId("live-away");
		await expect(away).toBeVisible({ timeout: 10_000 });
		await expect(away).toContainText("The student is away");
		await expect(instructor.getByTestId("helper-terminal")).toHaveCount(0);
		await expectNoViolations(instructor);

		await setWorkspaceState(setup.workspaceId, "running");
		await expect(instructor.getByTestId("helper-terminal")).toHaveAttribute(
			"data-connected",
			"true",
			{ timeout: 15_000 },
		);
		await expect(away).toHaveCount(0);
	} finally {
		await setup.instructorContext.close();
	}
});

test("Leave session ends it for both and goes back to the list", async ({
	page,
	context,
	browser,
}) => {
	const setup = await setUp(page, context, browser);
	try {
		const instructor = setup.instructor;
		await openSession(setup);
		await instructor.getByRole("button", { name: "Leave session" }).click();
		await expect(instructor.getByTestId("live-empty")).toBeVisible();
		const heading = instructor.getByRole("heading", { level: 1 });
		await expect(heading).toHaveText("Live help");
		// The button is gone, so the keyboard lands on the list's heading.
		await expect(heading).toBeFocused();
		await expectNoViolations(instructor);
		const [row] = await query<{ ended_at: string | null }>(
			"select ended_at from live_help_sessions where project_id = $1",
			[setup.projectId],
		);
		expect(row?.ended_at).not.toBeNull();
	} finally {
		await setup.instructorContext.close();
	}
});

test("the instructor opens a preview of the student's server in a new tab", async ({
	page,
	context,
	browser,
}) => {
	const setup = await setUp(page, context, browser);
	try {
		const instructor = setup.instructor;
		// The fake agent serves a small page on a port in the student's
		// workspace, standing in for a server started in their terminal.
		const port = await startPreviewApp(setup.workspaceId, "Ada's app");
		await previewGateway(setup.instructorContext);
		await openSession(setup);

		const previews = instructor.getByTestId("live-previews");
		await expect(previews).toContainText(`Port ${port}`, { timeout: 20_000 });
		await expectNoViolationsInBothThemes(instructor);

		const [tab] = await Promise.all([
			setup.instructorContext.waitForEvent("page"),
			previews.getByRole("button", { name: `Open in new tab, port ${port}` }).click(),
		]);
		await expect
			.poll(
				() => {
					try {
						return new URL(tab.url()).hostname.endsWith(PREVIEW_SUFFIX);
					} catch {
						return false;
					}
				},
				{ timeout: 20_000 },
			)
			.toBe(true);
		expect(new URL(tab.url()).hostname).toContain(`-${port}${PREVIEW_SUFFIX}`);
		await expect(tab.locator("h1")).toHaveText("Ada's app", { timeout: 20_000 });
		// The tab cannot reach back into the instructor's Portikus page.
		expect(await tab.evaluate(() => window.opener)).toBeNull();
		await tab.close();
	} finally {
		await setup.instructorContext.close();
	}
});

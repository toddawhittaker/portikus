/**
 * Course profiles (SPEC.md section 8.7): Traditional hides the agent
 * launchers, the Docker section and the system rows of the Running pane, and
 * never blocks. An instructor or an administrator sets it, a student sees it
 * at the next page load or window focus, and the administrator's code-help
 * switch is saved and audited (SPEC.md section 13.6). Every test makes the
 * courses it needs, so they run side by side.
 */
import { expect, type Page, test } from "@playwright/test";
import { join, newCourse, profileOf } from "./course-profile-helpers";
import {
	CODE_HELP_SWITCH_LOCK,
	createProject,
	createSignedInUser,
	createStudent,
	lockSharedState,
	loginAs,
	query,
	resetCodeHelpLanguages,
	SETTINGS_ROW_LOCK,
	seedListening,
	seedStorage,
	toast,
	WEB_ORIGIN,
	workspacePath,
} from "./helpers";

/** Two animation frames, so React has drawn what the last response changed. */
async function drawn(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((done) =>
				requestAnimationFrame(() => requestAnimationFrame(() => done())),
			),
	);
}

/** Open a fresh project of the student's workspace, once their settings have arrived. */
async function openWorkspace(page: Page, workspaceId: string) {
	const project = await createProject(workspaceId, {
		name: `Profile ${crypto.randomUUID().slice(0, 6)}`,
	});
	await seedListening(workspaceId, [
		{ port: 5173, process: { pid: 4242, command: "node" } },
		{ port: 5355, system: true, process: { pid: 7, command: "systemd-resolve" } },
	]);
	await load(page, workspacePath(workspaceId, project.id));
}

async function load(page: Page, path: string) {
	const settings = page.waitForResponse(
		(response) => new URL(response.url()).pathname === "/me/settings",
	);
	await page.goto(path);
	await settings;
	await expect(page.getByTestId("work-tabs")).toBeVisible({ timeout: 15_000 });
	await drawn(page);
}

async function openStatusDialog(page: Page) {
	await page.getByTestId("workspace-status").click();
	const dialog = page.getByTestId("dialog-workspace-status");
	await expect(dialog.getByRole("heading", { name: "Storage" })).toBeVisible();
	return dialog;
}

/** Everything Traditional hides is gone, and what stays is still there. */
async function expectTraditional(page: Page) {
	await expect(
		page.getByText("Open a terminal. The + in the tab bar also opens previews."),
	).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("empty-open-terminal")).toBeVisible();
	await expect(page.getByRole("button", { name: "Start Claude Code" })).toHaveCount(0);

	await page.getByTestId("launcher").click();
	await expect(page.getByTestId("launcher-terminal")).toBeVisible();
	await expect(page.getByTestId("launcher-preview")).toBeVisible();
	await expect(page.getByTestId("launcher-claude")).toHaveCount(0);
	await expect(page.getByTestId("launcher-codex")).toHaveCount(0);
	await expect(page.getByRole("menuitem", { name: /Claude Code|Codex/ })).toHaveCount(
		0,
	);
	await page.keyboard.press("Escape");

	const dialog = await openStatusDialog(page);
	await expect(dialog.getByRole("heading", { name: "Docker" })).toHaveCount(0);
	await expect(dialog.getByTestId("workspace-reset-docker")).toHaveCount(0);
	await expect(dialog.getByRole("heading", { name: "Rebuilds" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);

	await page.getByTestId("right-pane-tab-running").click();
	await expect(page.getByTestId("running-row-5173")).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId("running-system-toggle")).toHaveCount(0);
	await expect(page.getByTestId("running-row-5355")).toHaveCount(0);
}

/** The whole interface, as before profiles. */
async function expectAgentic(page: Page) {
	await expect(
		page.getByText(
			"Open a terminal or start Claude Code. The + in the tab bar also opens Codex and previews.",
		),
	).toBeVisible({ timeout: 15_000 });
	await expect(page.getByRole("button", { name: "Start Claude Code" })).toBeVisible();

	await page.getByTestId("launcher").click();
	await expect(page.getByTestId("launcher-claude")).toBeVisible();
	await expect(page.getByTestId("launcher-codex")).toBeVisible();
	await page.keyboard.press("Escape");

	const dialog = await openStatusDialog(page);
	await expect(dialog.getByRole("heading", { name: "Docker" })).toBeVisible();
	await expect(dialog.getByTestId("workspace-reset-docker")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);

	await page.getByTestId("right-pane-tab-running").click();
	await expect(page.getByTestId("running-row-5173")).toBeVisible({ timeout: 20_000 });
	await page.getByTestId("running-system-toggle").locator("input").check();
	await expect(page.getByTestId("running-row-5355")).toBeVisible();
}

test("a student in a Traditional course sees none of the hidden controls", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const course = await newCourse("traditional");
	await join(course.id, student.userId, "student");
	await openWorkspace(page, student.workspaceId);
	await expectTraditional(page);
});

test("a student in no course sees the whole interface", async ({ page, context }) => {
	const student = await createStudent(context);
	await openWorkspace(page, student.workspaceId);
	await expectAgentic(page);
});

test("a student in an Agentic course sees the whole interface", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const course = await newCourse("agentic");
	await join(course.id, student.userId, "student");
	await openWorkspace(page, student.workspaceId);
	await expectAgentic(page);
});

test("a student in a Traditional and an Agentic course gets the fullest interface", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await join((await newCourse("traditional")).id, student.userId, "student");
	await join((await newCourse("agentic")).id, student.userId, "student");
	await openWorkspace(page, student.workspaceId);
	await expectAgentic(page);
});

test("a student in two Traditional courses gets the Traditional interface", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await join((await newCourse("traditional")).id, student.userId, "student");
	await join((await newCourse("traditional")).id, student.userId, "student");
	await openWorkspace(page, student.workspaceId);
	await expectTraditional(page);
});

test("an instructor of a Traditional course still sees the whole interface", async ({
	page,
	context,
}) => {
	const teacher = await createStudent(context);
	const course = await newCourse("traditional");
	await join(course.id, teacher.userId, "instructor");
	await openWorkspace(page, teacher.workspaceId);
	await expectAgentic(page);
});

test("a Traditional student whose storage is full can still reset Docker", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await join((await newCourse("traditional")).id, student.userId, "student");
	await query(
		`update workspaces
		    set state = 'error', error_code = 'STORAGE_FULL',
		        error_message = 'Your workspace could not start because its storage is full.'
		  where id = $1`,
		[student.workspaceId],
	);
	const GIB = 1024 ** 3;
	await seedStorage(student.workspaceId, {
		home: { usedBytes: 3 * GIB, totalBytes: 10 * GIB },
		docker: { usedBytes: 99 * GIB, totalBytes: 100 * GIB },
	});
	await page.goto(workspacePath(student.workspaceId));

	const progress = page.getByTestId("workspace-progress");
	await expect(progress).toHaveAttribute("data-phase", "error", { timeout: 15_000 });
	await expect(
		progress.getByRole("button", { name: "Reset Docker…", exact: true }),
	).toBeVisible();
});

test("an instructor sets the profile, the audit row names them, and the student sees it at the next load", async ({
	browser,
}) => {
	const course = await newCourse("agentic");
	const studentContext = await browser.newContext({ baseURL: WEB_ORIGIN });
	const teacherContext = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		const student = await createStudent(studentContext);
		await join(course.id, student.userId, "student");
		const teacher = await createSignedInUser(teacherContext, "student");
		await join(course.id, teacher.userId, "instructor");

		const studentPage = await studentContext.newPage();
		await openWorkspace(studentPage, student.workspaceId);
		await expectAgentic(studentPage);

		const page = await teacherContext.newPage();
		await page.goto(`/course/${course.id}`);
		const section = page.getByRole("region", { name: "Student interface" });
		await expect(section.getByRole("radio", { name: "Agentic" })).toBeChecked({
			timeout: 15_000,
		});
		await expect(section).toContainText("never blocks anything");
		await section.getByRole("radio", { name: "Traditional" }).check();
		await expect(toast(page, "Traditional saved")).toBeVisible();
		await expect(section.getByRole("radio", { name: "Traditional" })).toBeChecked();
		expect(await profileOf(course.id)).toBe("traditional");

		const audit = await query<{ actor: string; metadata: unknown }>(
			"select actor, metadata from audit_events where action = 'course.profile_changed' and target = $1",
			[course.id],
		);
		expect(audit).toHaveLength(1);
		expect(audit[0]?.actor).toBe(`user:${teacher.userId}`);
		expect(audit[0]?.metadata).toMatchObject({ from: "agentic", to: "traditional" });

		// The page keeps the saved choice after a reload.
		await page.reload();
		await expect(
			page
				.getByRole("region", { name: "Student interface" })
				.getByRole("radio", { name: "Traditional" }),
		).toBeChecked({ timeout: 15_000 });

		// The student's open page is unchanged until the next load.
		await expect(studentPage.getByTestId("launcher")).toBeVisible();
		await load(studentPage, studentPage.url());
		await expectTraditional(studentPage);
	} finally {
		await studentContext.close();
		await teacherContext.close();
	}
});

test("an instructor of another course cannot set this course's profile", async ({
	context,
	page,
}) => {
	const course = await newCourse("agentic");
	const other = await newCourse("agentic");
	const teacher = await createSignedInUser(context, "student");
	await join(other.id, teacher.userId, "instructor");

	const response = await page.request.put(`/courses/${course.id}/profile`, {
		data: { profile: "traditional" },
	});
	expect(response.status()).toBe(403);
	expect(await profileOf(course.id)).toBe("agentic");
});

test("a student's open page picks up a profile change when the window gains focus", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const course = await newCourse("agentic");
	await join(course.id, student.userId, "student");
	await openWorkspace(page, student.workspaceId);
	await expect(page.getByRole("button", { name: "Start Claude Code" })).toBeVisible();

	await query("update lti_contexts set profile = 'traditional' where id = $1", [
		course.id,
	]);
	// The settings count as fresh for 5 seconds, so leave and return to the
	// window until they refetch.
	await expect(async () => {
		await page.evaluate(() => {
			const visibility = (state: string) => {
				Object.defineProperty(document, "visibilityState", {
					configurable: true,
					value: state,
				});
				document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
			};
			visibility("hidden");
			visibility("visible");
		});
		await expect(page.getByRole("button", { name: "Start Claude Code" })).toHaveCount(
			0,
			{
				timeout: 1000,
			},
		);
	}).toPass({ timeout: 20_000 });
});

test("an administrator sets a course's profile on the Sign-in tab", async ({
	browser,
	page,
}) => {
	const course = await newCourse("agentic");
	const studentContext = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		const student = await createStudent(studentContext);
		await join(course.id, student.userId, "student");

		await loginAs(page, "carol");
		await page.goto("/admin/signin");
		const group = page.getByRole("region", { name: "Courses" });
		const row = group.getByTestId("courses-row").filter({ hasText: course.title });
		const choice = row.getByRole("combobox", { name: `Profile for ${course.title}` });
		await expect(choice).toContainText("Agentic", { timeout: 15_000 });
		await expect(group).toContainText("never blocks anything");

		// Hold the save so the busy state can be seen: focus stays on the control.
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route(`**/admin/courses/${course.id}/profile`, async (route) => {
			await held;
			await route.continue();
		});
		await choice.click();
		await page.getByRole("option", { name: "Traditional" }).click();
		await expect(choice).toHaveAttribute("aria-disabled", "true");
		await expect(choice).toBeFocused();
		release();
		await expect(toast(page, `${course.title} is now Traditional`)).toBeVisible();
		await expect(choice).not.toHaveAttribute("aria-disabled", "true");
		await expect(choice).toBeFocused();
		await expect(choice).toContainText("Traditional");
		expect(await profileOf(course.id)).toBe("traditional");

		const audit = await query<{ actor: string; metadata: unknown }>(
			"select actor, metadata from audit_events where action = 'course.profile_changed' and target = $1",
			[course.id],
		);
		expect(audit).toHaveLength(1);
		expect(audit[0]?.actor).toMatch(/^user:/);
		expect(audit[0]?.metadata).toMatchObject({ from: "agentic", to: "traditional" });

		const studentPage = await studentContext.newPage();
		await openWorkspace(studentPage, student.workspaceId);
		await expectTraditional(studentPage);
	} finally {
		await studentContext.close();
	}
});

test.describe("the code-help site switch", () => {
	test.describe.configure({ mode: "serial" });
	const releases: (() => Promise<void>)[] = [];

	test.beforeAll(async () => {
		test.setTimeout(600_000);
		releases.push(await lockSharedState(SETTINGS_ROW_LOCK));
		releases.push(await lockSharedState(CODE_HELP_SWITCH_LOCK));
		await resetCodeHelpLanguages();
	});

	test.afterAll(async () => {
		await resetCodeHelpLanguages();
		for (const release of releases.reverse()) await release();
	});

	async function studentSees(page: Page): Promise<boolean> {
		const response = await page.request.get("/me/settings");
		const { codeHelpLanguages } = (await response.json()) as {
			codeHelpLanguages: string[];
		};
		return codeHelpLanguages.length > 0;
	}

	test("an administrator turns code help off and on, each change is audited, and students are told", async ({
		browser,
		page,
		context,
	}) => {
		test.setTimeout(120_000);
		await createStudent(context);
		const adminContext = await browser.newContext();
		try {
			const admin = await adminContext.newPage();
			await loginAs(admin, "carol");
			await admin.goto("/admin/settings");
			const card = admin.getByRole("region", { name: "Student tools" });
			const python = card.getByRole("checkbox", { name: "Python" });
			const typescript = card.getByRole("checkbox", {
				name: "TypeScript and JavaScript",
			});
			const save = card.getByRole("button", { name: "Save student tools" });
			await expect(python).toBeChecked({ timeout: 15_000 });
			await expect(typescript).toBeChecked();
			// It sits beside voice input, and says what an unticked language gets.
			await expect(card).toContainText(
				"A language left unticked still opens in the editor with syntax colouring",
			);
			expect(await studentSees(page)).toBe(true);

			await python.click();
			await typescript.click();
			// Nothing changes for students until Save.
			expect(await studentSees(page)).toBe(true);
			await save.click();
			await expect(admin.getByTestId("settings-tools-state")).toHaveText("Saved.");
			await expect(admin.getByTestId("code-help-headline")).toHaveText(
				"Code help is off. The editor shows syntax colouring only.",
			);
			expect(await studentSees(page)).toBe(false);

			await python.click();
			await typescript.click();
			await save.click();
			await expect(admin.getByTestId("settings-tools-state")).toHaveText("Saved.");
			await expect(python).toBeChecked();
			expect(await studentSees(page)).toBe(true);

			const audit = await query<{ metadata: unknown }>(
				"select metadata from audit_events where action = 'settings.code_help_updated' order by id desc limit 2",
			);
			expect(audit.map((row) => row.metadata)).toMatchObject([
				{ from: [], to: ["python", "typescript"] },
				{ from: ["python", "typescript"], to: [] },
			]);
		} finally {
			await adminContext.close();
		}
	});
});

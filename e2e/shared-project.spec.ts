/**
 * An instructor's read-only view of a project a student shared (SPEC.md
 * §5.2, ADR 0057): files, Git changes and check results, polled every 10
 * seconds, with secrets filtered out and no way to write.
 */
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
	expectNoViolations,
	query,
	seedFile,
	seedGit,
	setWorkspaceState,
	type TestProject,
	type TestStudent,
	WEB_ORIGIN,
} from "./helpers";

/** A one-pixel PNG, so the browser has a real image to draw. */
const PIXEL = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

/** A command that looks like it holds a token, which an instructor must never see. */
const SECRET_COMMAND = "npm test -- --token=e2e-ghp-NOT-FOR-INSTRUCTORS";

const CHECKS = {
	checks: [{ id: "tests", name: "Tests", command: SECRET_COMMAND }],
};

function status(entries: { path: string; x: string; y: string }[]) {
	return {
		repo: true,
		branch: "main",
		detached: false,
		upstream: null,
		ahead: 0,
		behind: 0,
		conflicts: 0,
		entries: entries.map((entry) => ({ ...entry, unmerged: false })),
		ignored: [],
		truncated: false,
	};
}

const APP_DIFF = {
	status: "M",
	before: "export const answer = 41;\n",
	after: "export const answer = 42;\n",
	binary: false,
	tooLarge: false,
};

interface Shared {
	instructor: BrowserContext;
	student: BrowserContext;
	owner: TestStudent;
	project: TestProject;
	courseId: string;
	page: Page;
}

/**
 * A course of its own with one instructor and one student, a project with a
 * few files, secrets among them, a check that has run, and an open share.
 */
async function sharedProject(
	browser: Browser,
	colorScheme: "light" | "dark" = "light",
): Promise<Shared> {
	const instructor = await browser.newContext({ baseURL: WEB_ORIGIN, colorScheme });
	const student = await browser.newContext({ baseURL: WEB_ORIGIN });
	const teacher = await createSignedInUser(instructor, "student");
	const owner = await createStudent(student);
	const tag = owner.userId.slice(0, 8);
	await query("update users set display_name = $2 where id = $1", [
		owner.userId,
		`Shari ${tag}`,
	]);
	const [course] = await query<{ id: string }>(
		`insert into lti_contexts (platform_issuer, context_id, title, platform_name)
		 values ('e2e-share', $1, $2, 'E2E LMS') returning id`,
		[`share-${tag}`, `Share ${tag}`],
	);
	if (!course) throw new Error("could not create the course");
	await query(
		`insert into lti_memberships (context_id, user_id, role, last_launch_at)
		 values ($1, $2, 'instructor', now()), ($1, $3, 'student', now())`,
		[course.id, teacher.userId, owner.userId],
	);

	const project = await createProject(owner.workspaceId, { name: `Shared ${tag}` });
	const files: Record<string, string | Buffer> = {
		"README.md": "# Hello\n",
		"src/app.js": APP_DIFF.after,
		"assets/dot.png": PIXEL,
		".env": "SECRET=hunter2\n",
		".env.example": "SECRET=\n",
		id_rsa: "-----BEGIN KEY-----\n",
		".portikus/checks.json": JSON.stringify(CHECKS),
	};
	for (const [path, content] of Object.entries(files)) {
		await seedFile(owner.workspaceId, project.slug, path, content);
	}
	await seedGit(owner.workspaceId, project.slug, {
		status: status([
			{ path: "src/app.js", x: ".", y: "M" },
			{ path: ".env", x: ".", y: "M" },
		]),
		diffs: { "src/app.js": APP_DIFF },
	});

	// The student runs the check and starts the share, as the API lets them.
	const base = `/workspaces/${owner.workspaceId}/projects/${project.id}`;
	const ran = await student.request.post(`${base}/checks/tests/runs`, {
		headers: { origin: WEB_ORIGIN },
	});
	expect(ran.status()).toBe(201);
	const shared = await student.request.post(`${base}/share`, {
		headers: { origin: WEB_ORIGIN },
	});
	expect(shared.ok()).toBe(true);

	const page = await instructor.newPage();
	await page.goto(`/course/${course.id}/shares/${project.id}`);
	await expect(page.getByRole("heading", { level: 1, name: project.name })).toBeVisible(
		{
			timeout: 15_000,
		},
	);
	return { instructor, student, owner, project, courseId: course.id, page };
}

async function close(shared: Shared) {
	await shared.instructor.close();
	await shared.student.close();
}

test("an instructor browses a shared project without its secrets", async ({
	browser,
}) => {
	const shared = await sharedProject(browser);
	try {
		const { page } = shared;
		await expect(page.getByTestId("shared-byline")).toContainText("Shared by Shari");
		const tree = page.getByTestId("shared-tree");
		await expect(tree.getByTestId("shared-row-README.md")).toBeVisible();
		await page
			.getByRole("checkbox", { name: "Show hidden and generated files" })
			.check();
		await expect(tree.getByTestId("shared-row-.env.example")).toBeVisible();
		// The API leaves these out of every read (ADR 0057).
		for (const secret of [".env", "id_rsa", ".portikus"]) {
			await expect(tree.getByTestId(`shared-row-${secret}`)).toHaveCount(0);
		}
		const changes = page.getByTestId("shared-changes");
		await expect(changes.getByTestId("shared-change-src/app.js")).toBeVisible();
		await expect(changes.getByTestId("shared-change-.env")).toHaveCount(0);

		// A text file opens read-only.
		await tree.getByTestId("shared-row-README.md").click();
		const text = page.getByTestId("shared-text-README.md");
		await expect(text.locator(".view-lines")).toContainText("Hello", {
			timeout: 15_000,
		});
		await expect(text.locator("textarea")).toHaveAttribute("readonly", /.*/);

		// An image is drawn inline.
		await tree.getByTestId("shared-row-assets").click();
		await tree.getByTestId("shared-row-assets/dot.png").click();
		await expect(page.getByRole("img", { name: "dot.png" })).toBeVisible();

		// A change opens its diff.
		await changes.getByTestId("shared-change-src/app.js").click();
		await expect(
			page.getByTestId("shared-diff-src/app.js").locator(".modified .view-lines"),
		).toContainText("42", { timeout: 15_000 });
		// The right side is the student's, not the instructor's own (SPEC.md §25.8).
		await expect(
			page.getByTestId("shared-diff-src/app.js").getByRole("textbox").nth(1),
		).toHaveAccessibleName(
			"Diff, the student's version, src/app.js. Ctrl+M makes Tab leave the editor.",
		);

		await expect(page.getByTestId("shared-check-state-tests")).toHaveText("Passed");
		await expect(page.getByTestId("shared-check-tests")).toContainText("Finished");
		await expect(page.getByTestId("page-shared-project")).not.toContainText(
			"NOT-FOR-INSTRUCTORS",
		);

		// The student's first-view notice and the viewer list (ADR 0057).
		const viewers = await shared.student.request.get(
			`/workspaces/${shared.owner.workspaceId}/projects/${shared.project.id}/share`,
		);
		expect(((await viewers.json()) as { viewers: unknown[] }).viewers).toHaveLength(1);
	} finally {
		await close(shared);
	}
});

test("nothing on the page writes, downloads, or opens a terminal or preview", async ({
	browser,
}) => {
	const shared = await sharedProject(browser);
	try {
		const { page } = shared;
		const main = page.getByTestId("page-shared-project");
		await main.getByTestId("shared-row-README.md").click();
		await expect(
			main.getByTestId("shared-text-README.md").locator(".view-lines"),
		).toContainText("Hello", { timeout: 15_000 });
		await main.getByTestId("shared-change-src/app.js").click();
		await expect(main.getByTestId("shared-diff-src/app.js")).toBeVisible();

		const names = await main.getByRole("button").allTextContents();
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) {
			expect(name).not.toMatch(
				/edit|save|rename|delete|upload|download|terminal|preview|run|stop|new|move/i,
			);
		}
		await expect(main.getByRole("link")).toHaveText(["Back to the course"]);
		// Monaco keeps a textarea for the keyboard; every one is read-only.
		for (const box of await main.locator("textarea").all()) {
			await expect(box).toHaveAttribute("readonly", /.*/);
		}
	} finally {
		await close(shared);
	}
});

test("a change in the workspace shows up on the next refresh", async ({ browser }) => {
	const shared = await sharedProject(browser);
	try {
		const { page, owner, project } = shared;
		await page.getByTestId("shared-row-README.md").click();
		const text = page.getByTestId("shared-text-README.md").locator(".view-lines");
		await expect(text).toContainText("Hello", { timeout: 15_000 });

		await seedFile(owner.workspaceId, project.slug, "README.md", "# Goodbye\n");
		await seedFile(owner.workspaceId, project.slug, "notes.md", "later\n");
		await seedGit(owner.workspaceId, project.slug, {
			status: status([
				{ path: "src/app.js", x: ".", y: "M" },
				{ path: "notes.md", x: "?", y: "?" },
			]),
			diffs: { "src/app.js": APP_DIFF },
		});

		// One poll is 10 seconds; allow for two.
		await expect(text).toContainText("Goodbye", { timeout: 25_000 });
		await expect(
			page.getByTestId("shared-tree").getByTestId("shared-row-notes.md"),
		).toBeVisible({
			timeout: 25_000,
		});
		await expect(
			page.getByTestId("shared-changes").getByTestId("shared-change-notes.md"),
		).toBeVisible({ timeout: 25_000 });
	} finally {
		await close(shared);
	}
});

test("a stopped workspace is announced and keeps the reader's place; an ended share says it is gone", async ({
	browser,
}) => {
	const shared = await sharedProject(browser);
	try {
		const { page, owner, project, courseId } = shared;
		const readme = page.getByTestId("shared-row-README.md");
		await readme.click();
		await expect(
			page.getByTestId("shared-text-README.md").locator(".view-lines"),
		).toContainText("Hello", { timeout: 15_000 });
		await readme.focus();

		// The next poll finds it stopped: announced, and the focus kept on the page.
		await setWorkspaceState(owner.workspaceId, "stopped");
		await expect(page.getByTestId("shared-stopped")).toContainText(
			"The workspace is stopped",
			{ timeout: 25_000 },
		);
		await expect(page.getByTestId("shared-status")).toHaveText(
			"The workspace is stopped",
		);
		await expect(
			page.getByRole("heading", { level: 1, name: project.name }),
		).toBeFocused();
		await expect(page.getByTestId("shared-tree")).toHaveCount(0);
		await expectNoViolations(page);
		// The view never starts it (ADR 0057).
		const [row] = await query<{ state: string }>(
			"select state from workspaces where id = $1",
			[owner.workspaceId],
		);
		expect(row?.state).toBe("stopped");

		// Started again, the file that was open is open again.
		await setWorkspaceState(owner.workspaceId, "running");
		await expect(
			page.getByTestId("shared-text-README.md").locator(".view-lines"),
		).toContainText("Hello", { timeout: 25_000 });
		await expect(page.getByTestId("shared-status")).toHaveText("");

		const stopped = await shared.student.request.post(
			`/workspaces/${owner.workspaceId}/projects/${project.id}/share/stop`,
			{ headers: { origin: WEB_ORIGIN } },
		);
		expect(stopped.ok()).toBe(true);
		await page.goto(`/course/${courseId}/shares/${project.id}`);
		await expect(page.getByTestId("shared-gone")).toContainText(
			"This share is not available",
			{ timeout: 15_000 },
		);
		await expect(page.getByTestId("shared-status")).toHaveText(
			"This share is not available",
		);
		await expectNoViolations(page);
	} finally {
		await close(shared);
	}
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`the shared project view has no automatic accessibility violations (${colorScheme})`, async ({
		browser,
	}) => {
		const shared = await sharedProject(browser, colorScheme);
		try {
			const { page } = shared;
			await page.getByTestId("shared-row-src").click();
			await expect(page.getByTestId("shared-row-src/app.js")).toBeVisible();
			await page.getByTestId("shared-change-src/app.js").click();
			await expect(page.getByTestId("shared-diff-sides")).toBeVisible();
			await expect(page.getByTestId("shared-check-state-tests")).toHaveText("Passed");
			await expectNoViolations(page);
		} finally {
			await close(shared);
		}
	});
}

import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	newTerminal,
	openFileTab,
	query,
	type TestStudent,
	terminalIds,
	WEB_ORIGIN,
	workspacePath,
} from "./helpers";

/**
 * Two browsers on one project see each other's layout changes, and a stale
 * browser cannot overwrite a newer layout (SPEC.md §7.5).
 */

function pane(page: Page, terminalId: string) {
	return page.getByTestId(`terminal-pane-${terminalId}`);
}

async function secondBrowser(
	browser: import("@playwright/test").Browser,
	student: TestStudent,
): Promise<BrowserContext> {
	const second = await browser.newContext({ baseURL: WEB_ORIGIN });
	await second.addCookies([
		{ name: "portikus_session", value: student.sessionToken, url: WEB_ORIGIN },
	]);
	return second;
}

/** Open the project in `page` and wait for its work area. */
async function open(page: Page, workspaceId: string, projectId: string) {
	await page.goto(workspacePath(workspaceId, projectId));
	await expect(page.getByTestId("work-tabs")).toBeVisible({ timeout: 15_000 });
}

async function projectWithTerminal(page: Page, workspaceId: string, name: string) {
	const project = await createProject(workspaceId, { name });
	await open(page, workspaceId, project.id);
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(workspaceId, project.id)).length)
		.toBe(1);
	const [terminalId] = await terminalIds(workspaceId, project.id);
	if (!terminalId) throw new Error("the terminal row was not created");
	await expectConnected(page, terminalId);
	// Wait for the first save, so both browsers start from the same version.
	await expect
		.poll(async () => {
			const rows = await query<{ layout_version: number }>(
				"select layout_version from projects where id = $1",
				[project.id],
			);
			return rows[0]?.layout_version ?? 0;
		})
		.toBeGreaterThan(0);
	return { projectId: project.id, terminalId };
}

async function splitRight(page: Page, terminalId: string) {
	await page.getByTestId(`terminal-actions-${terminalId}`).click();
	await page.getByTestId("split-right").click();
}

test("a split made in one browser shows in the other", async ({ browser, context }) => {
	const student = await createStudent(context);
	const a = await context.newPage();
	const { projectId, terminalId } = await projectWithTerminal(
		a,
		student.workspaceId,
		"Synced",
	);
	const second = await secondBrowser(browser, student);
	try {
		const b = await second.newPage();
		await open(b, student.workspaceId, projectId);
		await expect(pane(b, terminalId)).toBeVisible({ timeout: 15_000 });

		await splitRight(a, terminalId);
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(2);
		const [, added] = await terminalIds(student.workspaceId, projectId);

		// The save waits a second after the change; the announcement is
		// immediate. Both panes sit in B's one tab, as in A.
		await expect(pane(b, added as string)).toBeVisible({ timeout: 5_000 });
		await expect(pane(b, terminalId)).toBeVisible();
		await expect(b.getByTestId("work-tabs").getByRole("tab")).toHaveCount(1);
	} finally {
		await second.close();
	}
});

test("a stale browser's save is refused and it takes the newer layout", async ({
	browser,
	context,
}) => {
	const student = await createStudent(context);
	const a = await context.newPage();
	const { projectId, terminalId } = await projectWithTerminal(
		a,
		student.workspaceId,
		"Stale",
	);
	const second = await secondBrowser(browser, student);
	try {
		const b = await second.newPage();
		// B never hears an announcement, so it stays on the version it read.
		await b.routeWebSocket(/\/workspaces\/[^/]+\/ws$/, (socket) => {
			const server = socket.connectToServer();
			server.onMessage((message) => {
				if (!String(message).includes('"type":"layout"')) socket.send(message);
			});
		});
		await open(b, student.workspaceId, projectId);
		await expect(pane(b, terminalId)).toBeVisible({ timeout: 15_000 });

		await splitRight(a, terminalId);
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(2);
		const [, added] = await terminalIds(student.workspaceId, projectId);
		const splitSaved = async () => {
			const rows = await query<{ layout: { tabs: Array<{ root: { type: string } }> } }>(
				"select layout from projects where id = $1",
				[projectId],
			);
			return rows[0]?.layout.tabs.some((tab) => tab.root.type === "split") ?? false;
		};
		await expect.poll(splitSaved).toBe(true);

		const refused = b.waitForResponse(
			(response) =>
				response.url().endsWith("/layout") &&
				response.request().method() === "PUT" &&
				response.status() === 412,
		);
		await newTerminal(b);
		await refused;

		// A's split survives, and B now shows it.
		expect(await splitSaved()).toBe(true);
		await expect(pane(b, added as string)).toBeVisible({ timeout: 5_000 });
	} finally {
		await second.close();
	}
});

test("a tab closed in another browser while it had focus hands focus to the work area", async ({
	browser,
	context,
}) => {
	// Monaco is a large chunk the dev server transforms on first use.
	test.setTimeout(90_000);
	const student = await createStudent(context);
	const a = await context.newPage();
	const path = "notes.txt";
	const project = await openFileTab(a, student, "Focus Moves", path, "hello\n");
	const lines = a.getByTestId(`editor-${path}`).locator(".view-lines");
	await expect(lines).toContainText("hello", { timeout: 60_000 });
	await lines.click();
	await expect
		.poll(() =>
			a.evaluate(
				(id) => !!document.activeElement?.closest(`[data-testid="file-pane-${id}"]`),
				path,
			),
		)
		.toBe(true);

	const second = await secondBrowser(browser, student);
	try {
		const b = await second.newPage();
		await open(b, student.workspaceId, project.id);
		await b.getByTestId(`tab-file:${path}-close`).click();
		await expect(b.getByTestId(`tab-file:${path}`)).toHaveCount(0);

		await expect(a.getByTestId(`tab-file:${path}`)).toHaveCount(0, { timeout: 5_000 });
		await expect(a.getByRole("main", { name: "Work area" })).toBeFocused();
		await expect(a.getByTestId("layout-announce")).toHaveText(
			"The layout changed in another browser.",
		);
	} finally {
		await second.close();
	}
});

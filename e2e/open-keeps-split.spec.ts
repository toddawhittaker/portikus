/**
 * Opening a file from the tree adds a tab of its own and leaves a split
 * elsewhere in the layout as it was, in this browser and in another one on
 * the same project (SPEC.md §7.5, §11.2).
 */
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	newTerminal,
	query,
	seedFile,
	type TestStudent,
	terminalIds,
	WEB_ORIGIN,
	workspacePath,
	workTabs,
} from "./helpers";

test.describe.configure({ timeout: 90_000 });

function pane(page: Page, terminalId: string) {
	return page.getByTestId(`terminal-pane-${terminalId}`);
}

async function secondPage(browser: Browser, student: TestStudent): Promise<Page> {
	const second = await browser.newContext({ baseURL: WEB_ORIGIN });
	await second.addCookies([
		{ name: "portikus_session", value: student.sessionToken, url: WEB_ORIGIN },
	]);
	return second.newPage();
}

async function splitProject(page: Page, student: TestStudent, name: string) {
	const project = await createProject(student.workspaceId, { name });
	await seedFile(student.workspaceId, project.slug, "README.md", "# readme\n");
	await seedFile(student.workspaceId, project.slug, "notes.txt", "notes\n");
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(page.getByTestId("file-row-README.md")).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [first] = await terminalIds(student.workspaceId, project.id);
	if (!first) throw new Error("the terminal row was not created");
	await expectConnected(page, first);
	await page.getByTestId(`terminal-actions-${first}`).click();
	await page.getByTestId("split-right").click();
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(2);
	const [, second] = await terminalIds(student.workspaceId, project.id);
	if (!second) throw new Error("the split terminal was not created");
	await expect(pane(page, second)).toBeVisible();
	await expectConnected(page, second);
	await expect(workTabs(page).getByRole("tab")).toHaveCount(1);
	return { project, first, second };
}

async function splitSaved(projectId: string): Promise<boolean> {
	const rows = await query<{
		layout: { tabs: Array<{ root: { type: string } }> } | null;
	}>("select layout from projects where id = $1", [projectId]);
	return rows[0]?.layout?.tabs.some((tab) => tab.root.type === "split") ?? false;
}

for (const path of ["README.md", "notes.txt"]) {
	test(`opening ${path} keeps the terminal split`, async ({ page, context }) => {
		const student = await createStudent(context);
		const { project, first, second } = await splitProject(
			page,
			student,
			`Keep ${path}`,
		);

		await page.getByTestId(`file-row-${path}`).click();
		await expect(page.getByTestId(`tab-file:${path}`)).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await expect(workTabs(page).getByRole("tab")).toHaveCount(2);
		await page.getByTestId(`tab-${first}`).click();
		await expect(pane(page, first)).toBeVisible();
		await expect(pane(page, second)).toBeVisible();
		// Wait out the delayed save, then check the stored layout as well.
		await page.waitForTimeout(2_000);
		expect(await splitSaved(project.id)).toBe(true);
		await expect(workTabs(page).getByRole("tab")).toHaveCount(2);
	});
}

test("a file opened in one browser leaves the split in the other", async ({
	browser,
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { project, first, second } = await splitProject(page, student, "Keep both");
	await expect.poll(() => splitSaved(project.id)).toBe(true);
	const b = await secondPage(browser, student);
	try {
		await b.goto(workspacePath(student.workspaceId, project.id));
		await expect(pane(b, second)).toBeVisible({ timeout: 15_000 });

		await page.getByTestId("file-row-README.md").click();
		await expect(b.getByTestId("tab-file:README.md")).toBeVisible({ timeout: 5_000 });
		await expect(workTabs(b).getByRole("tab")).toHaveCount(2);
		await expect(pane(b, first)).toBeVisible();
		await expect(pane(b, second)).toBeVisible();
		await expect(workTabs(page).getByRole("tab")).toHaveCount(2);
	} finally {
		await b.context().close();
	}
});

test("a browser that lists a terminal before its split is placed does not save it as a tab", async ({
	browser,
	page,
	context,
}) => {
	// The other browser's list poll comes every 15 seconds.
	test.setTimeout(120_000);
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Slow split" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [first] = await terminalIds(student.workspaceId, project.id);
	if (!first) throw new Error("the terminal row was not created");
	await expectConnected(page, first);
	const version = async () => {
		const rows = await query<{ layout_version: number }>(
			"select layout_version from projects where id = $1",
			[project.id],
		);
		return rows[0]?.layout_version ?? 0;
	};
	await expect.poll(version).toBe(1);
	const b = await secondPage(browser, student);
	try {
		await b.goto(workspacePath(student.workspaceId, project.id));
		await expect(pane(b, first)).toBeVisible({ timeout: 15_000 });

		// The API lists a new terminal before its create call answers; on a
		// real host that answer can take seconds. Hold it past B's next poll.
		await page.route(/\/terminals$/, async (route) => {
			if (route.request().method() !== "POST") return route.fallback();
			const response = await route.fetch();
			await new Promise((resolve) => setTimeout(resolve, 20_000));
			await route.fulfill({ response });
		});
		await page.getByTestId(`terminal-actions-${first}`).click();
		await page.getByTestId("split-right").click();
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
			.toBe(2);
		const [, second] = await terminalIds(student.workspaceId, project.id);
		if (!second) throw new Error("the split terminal was not created");
		await expect(b.getByTestId(`tab-${second}`)).toBeVisible({ timeout: 20_000 });
		// B shows the terminal in a tab of its own but saves nothing.
		await b.waitForTimeout(2_000);
		expect(await version()).toBe(1);

		await expect.poll(() => splitSaved(project.id), { timeout: 20_000 }).toBe(true);
		for (const each of [page, b]) {
			await expect(workTabs(each).getByRole("tab")).toHaveCount(1);
			await expect(pane(each, first)).toBeVisible();
			await expect(pane(each, second)).toBeVisible();
		}
	} finally {
		await b.context().close();
	}
});

test("a file opened in the browser that received the split keeps it", async ({
	browser,
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Keep received" });
	await seedFile(student.workspaceId, project.slug, "README.md", "# readme\n");
	const b = await secondPage(browser, student);
	try {
		await page.goto(workspacePath(student.workspaceId, project.id));
		await b.goto(workspacePath(student.workspaceId, project.id));
		await expect(b.getByTestId("file-row-README.md")).toBeVisible({ timeout: 15_000 });
		await newTerminal(page);
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
			.toBe(1);
		const [first] = await terminalIds(student.workspaceId, project.id);
		if (!first) throw new Error("the terminal row was not created");
		await expectConnected(page, first);
		await expect(pane(b, first)).toBeVisible({ timeout: 5_000 });
		await page.getByTestId(`terminal-actions-${first}`).click();
		await page.getByTestId("split-right").click();
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
			.toBe(2);
		const [, second] = await terminalIds(student.workspaceId, project.id);
		if (!second) throw new Error("the split terminal was not created");
		await expect(pane(b, second)).toBeVisible({ timeout: 5_000 });
		await expect(workTabs(b).getByRole("tab")).toHaveCount(1);
		await expect.poll(() => splitSaved(project.id)).toBe(true);

		await b.getByTestId("file-row-README.md").click();
		await expect(b.getByTestId("tab-file:README.md")).toBeVisible();
		await expect(page.getByTestId("tab-file:README.md")).toBeVisible({
			timeout: 5_000,
		});
		// Wait out the delayed save before checking both browsers and the server.
		await page.waitForTimeout(2_000);
		for (const each of [page, b]) {
			await expect(workTabs(each).getByRole("tab")).toHaveCount(2);
			await each.getByTestId(`tab-${first}`).click();
			await expect(pane(each, first)).toBeVisible();
			await expect(pane(each, second)).toBeVisible();
		}
		expect(await splitSaved(project.id)).toBe(true);
	} finally {
		await b.context().close();
	}
});

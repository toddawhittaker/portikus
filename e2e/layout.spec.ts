import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	endTerminal,
	query,
	terminalIds,
	WEB_ORIGIN,
	workspacePath,
} from "./helpers";

/**
 * The tabbed work area, splits and the saved per-project layout (SPEC.md
 * §7.5, §8.3, §9.3). Written against the test ids the work-area builder owns
 * (plan, E2). The orchestrator removes the guard below once E1 and E2 land.
 */
test.describe("work area layout", () => {
	async function newTerminal(page: Page): Promise<void> {
		await page.getByTestId("launcher").click();
		await page.getByRole("menuitem", { name: "Terminal", exact: true }).click();
	}

	async function paneAction(
		page: Page,
		terminalId: string,
		testId: string,
	): Promise<void> {
		await page.getByTestId(`terminal-actions-${terminalId}`).click();
		await page.getByTestId(testId).click();
	}

	function pane(page: Page, terminalId: string) {
		return page.getByTestId(`terminal-pane-${terminalId}`);
	}

	async function expectConnected(page: Page, terminalId: string): Promise<void> {
		await expect(pane(page, terminalId)).toHaveAttribute("data-connected", "true", {
			timeout: 15_000,
		});
	}

	/** Open a project's work area with one terminal, and return both ids. */
	async function openProjectWithTerminal(
		page: Page,
		workspaceId: string,
		name: string,
	): Promise<{ projectId: string; terminalId: string }> {
		const project = await createProject(workspaceId, { name });
		await page.goto(workspacePath(workspaceId, project.id));
		await expect(page.getByTestId("work-tabs")).toBeVisible({ timeout: 15_000 });
		await newTerminal(page);
		await expect
			.poll(async () => (await terminalIds(workspaceId, project.id)).length)
			.toBe(1);
		const [terminalId] = await terminalIds(workspaceId, project.id);
		if (!terminalId) throw new Error("the terminal row was not created");
		await expectConnected(page, terminalId);
		return { projectId: project.id, terminalId };
	}

	test("splitting right puts a second terminal in the same tab", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { projectId, terminalId } = await openProjectWithTerminal(
			page,
			student.workspaceId,
			"Splits",
		);

		await paneAction(page, terminalId, "split-right");

		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(2);
		const ids = await terminalIds(student.workspaceId, projectId);
		const second = ids[1] as string;
		// Both panes live in the one tab, so the tab count does not move.
		await expect(page.getByTestId("work-tabs").getByRole("tab")).toHaveCount(1);
		await expect(pane(page, terminalId)).toBeVisible();
		await expect(pane(page, second)).toBeVisible();
		await expectConnected(page, second);
		// A terminal made from a project starts in the project (SPEC.md §9.4).
		const rows = await query<{ cwd: string }>(
			"select cwd from terminals where id = $1",
			[second],
		);
		expect(rows[0]?.cwd).toBe("/home/student/projects/splits");
	});

	test("splitting down stacks the panes in one tab", async ({ page, context }) => {
		const student = await createStudent(context);
		const { projectId, terminalId } = await openProjectWithTerminal(
			page,
			student.workspaceId,
			"Stacked",
		);

		await paneAction(page, terminalId, "split-down");

		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(2);
		const [, second] = await terminalIds(student.workspaceId, projectId);
		const group = page.getByTestId(/^terminal-group-/);
		await expect(group.first()).toBeVisible();
		await expect(pane(page, second as string)).toBeVisible();
		await expect(page.getByTestId("work-tabs").getByRole("tab")).toHaveCount(1);
	});

	test("tabs can be reordered from the keyboard", async ({ page, context }) => {
		const student = await createStudent(context);
		const { projectId, terminalId } = await openProjectWithTerminal(
			page,
			student.workspaceId,
			"Reorder",
		);
		await newTerminal(page);
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(2);
		const [, second] = await terminalIds(student.workspaceId, projectId);

		const tabs = page.getByTestId("work-tabs").getByRole("tab");
		await expect(tabs).toHaveCount(2);
		await page.getByTestId(`tab-${second}`).focus();
		await page.keyboard.press("Alt+Shift+ArrowLeft");

		// The second tab is now first (SPEC.md §8.3, tabs are reorderable).
		await expect(tabs.first()).toHaveAttribute("data-testid", `tab-${second}`);
		await expect(tabs.last()).toHaveAttribute("data-testid", `tab-${terminalId}`);
	});

	test("a reload restores the tabs, the splits and their order", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { projectId, terminalId } = await openProjectWithTerminal(
			page,
			student.workspaceId,
			"Restored",
		);
		await paneAction(page, terminalId, "split-right");
		await newTerminal(page);
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(3);
		const ids = await terminalIds(student.workspaceId, projectId);

		// The layout is saved a second after it changes (plan, Layout).
		await expect
			.poll(
				async () => {
					const rows = await query<{ layout: unknown }>(
						"select layout from projects where id = $1",
						[projectId],
					);
					return rows[0]?.layout === null ? null : "saved";
				},
				{ timeout: 10_000 },
			)
			.toBe("saved");

		await page.reload();

		await expect(page.getByTestId("work-tabs").getByRole("tab")).toHaveCount(2, {
			timeout: 15_000,
		});
		await expect(page.getByTestId(`terminal-pane-${ids[0]}`)).toBeVisible();
		await expect(page.getByTestId(`terminal-pane-${ids[1]}`)).toBeVisible();
		await expect(page.getByTestId(`tab-${ids[2]}`)).toBeVisible();
	});

	test("switching projects swaps the tab set and switching back restores it", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const beta = await createProject(student.workspaceId, { name: "Beta" });
		const first = await openProjectWithTerminal(page, student.workspaceId, "Alpha");
		await newTerminal(page);
		await expect
			.poll(
				async () => (await terminalIds(student.workspaceId, first.projectId)).length,
			)
			.toBe(2);

		await page.getByTestId(`project-item-${beta.id}`).click();

		await expect(page).toHaveURL(workspacePath(student.workspaceId, beta.id));
		await expect(page.getByTestId("work-tabs").getByRole("tab")).toHaveCount(0);
		await expect(page.getByTestId(`terminal-pane-${first.terminalId}`)).toHaveCount(0);

		await page.getByTestId(`project-item-${first.projectId}`).click();

		// Each project keeps its own terminal tabs (SPEC.md §7.5).
		await expect(page.getByTestId("work-tabs").getByRole("tab")).toHaveCount(2, {
			timeout: 15_000,
		});
		await expect(page.getByTestId(`tab-${first.terminalId}`)).toBeVisible();
	});

	test("a terminal opened in another window shows up here", async ({
		browser,
		context,
	}) => {
		const student = await createStudent(context);
		const page = await context.newPage();
		const { projectId } = await openProjectWithTerminal(
			page,
			student.workspaceId,
			"Shared",
		);

		const second = await browser.newContext({ baseURL: WEB_ORIGIN });
		await second.addCookies([
			{ name: "portikus_session", value: student.sessionToken, url: WEB_ORIGIN },
		]);
		const secondPage = await second.newPage();
		try {
			await secondPage.goto(workspacePath(student.workspaceId, projectId));
			await expect(secondPage.getByTestId("work-tabs")).toBeVisible({
				timeout: 15_000,
			});
			await newTerminal(secondPage);
			await expect
				.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
				.toBe(2);
			const [, added] = await terminalIds(student.workspaceId, projectId);

			// The first window reconciles on refetch and focus (plan, E2).
			await page.bringToFront();
			await expect(page.getByTestId(`tab-${added}`)).toBeVisible({
				timeout: 20_000,
			});
		} finally {
			await second.close();
		}
	});

	test("Ctrl+D closes the pane, and the tab when it was the last one", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { projectId, terminalId } = await openProjectWithTerminal(
			page,
			student.workspaceId,
			"Exiting",
		);
		await paneAction(page, terminalId, "split-right");
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(2);
		const [, second] = await terminalIds(student.workspaceId, projectId);
		await expectConnected(page, second as string);

		// The fake agent sends the exit frame when the end-of-file byte arrives.
		await pane(page, second as string)
			.locator(".xterm-screen")
			.click();
		await page.keyboard.press("Control+d");

		await expect(pane(page, second as string)).toHaveCount(0, { timeout: 15_000 });
		await expect(pane(page, terminalId)).toBeVisible();
		await expect(page.getByTestId("work-tabs").getByRole("tab")).toHaveCount(1);

		// Losing its neighbour re-lays out this pane, so wait for its socket
		// to be back before typing into it.
		await expectConnected(page, terminalId);
		await pane(page, terminalId).locator(".xterm-screen").click();
		await page.keyboard.press("Control+d");

		// The last leaf of a tab takes the tab with it (plan, decisions).
		await expect(page.getByTestId("work-tabs").getByRole("tab")).toHaveCount(0, {
			timeout: 15_000,
		});
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(0);
	});

	test("the pane menu and the tab close button both close a terminal", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { projectId, terminalId } = await openProjectWithTerminal(
			page,
			student.workspaceId,
			"Closing",
		);
		await paneAction(page, terminalId, "split-right");
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(2);
		const [, second] = await terminalIds(student.workspaceId, projectId);

		await page.getByTestId(`terminal-actions-${second}`).click();
		await page.getByRole("menuitem", { name: "Close" }).click();
		await expect(pane(page, second as string)).toHaveCount(0);

		await page
			.getByTestId(`tab-${terminalId}`)
			.getByRole("button", { name: /close/i })
			.click();

		await expect(page.getByTestId("work-tabs").getByRole("tab")).toHaveCount(0);
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(0);
	});

	test("a terminal ended by a workspace stop keeps its leaf", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { projectId, terminalId } = await openProjectWithTerminal(
			page,
			student.workspaceId,
			"Ended",
		);

		// What stopping the workspace does to the terminal rows (SPEC.md §6.8).
		await endTerminal(terminalId);
		await page.reload();

		await expect(page.getByTestId(`tab-${terminalId}`)).toBeVisible({
			timeout: 15_000,
		});
		await expect(
			page.getByText("This terminal ended when the workspace stopped"),
		).toBeVisible();
		await expect(page.getByRole("button", { name: "New terminal here" })).toBeVisible();
		expect(await terminalIds(student.workspaceId, projectId)).toEqual([terminalId]);
	});

	test("reviving an ended leaf gives a live terminal in its place", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { projectId, terminalId } = await openProjectWithTerminal(
			page,
			student.workspaceId,
			"Revived",
		);
		await endTerminal(terminalId);
		await page.reload();
		await expect(page.getByRole("button", { name: "New terminal here" })).toBeVisible({
			timeout: 15_000,
		});

		await page.getByRole("button", { name: "New terminal here" }).click();

		// The ended row stays in the listing (SPEC.md §9.7), so the new terminal
		// is the second one.
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(2);
		const ids = await terminalIds(student.workspaceId, projectId);
		const revived = ids.find((id) => id !== terminalId);
		if (!revived) throw new Error("the replacement terminal row was not created");
		// The new terminal takes the ended one's place and attaches for real.
		await expectConnected(page, revived);
		await expect(page.getByTestId(`terminal-leaf-${revived}`)).toBeVisible();
	});
});

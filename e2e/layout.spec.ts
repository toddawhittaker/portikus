import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	endTerminal,
	expectConnected,
	newTerminal,
	openFileTab,
	query,
	terminalIds,
	WEB_ORIGIN,
	waitForSavedLeaf,
	workspacePath,
} from "./helpers";

/**
 * The tabbed work area, splits and the saved per-project layout (SPEC.md
 * §7.5, §8.3, §9.3).
 */
test.describe("work area layout", () => {
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
		// The tab the student was on is the one that comes back (issue #161).
		await expect(page.getByTestId(`tab-${ids[2]}`)).toHaveAttribute(
			"data-state",
			"active",
		);
		await page.getByTestId(`tab-${ids[0]}`).click();
		await expect(page.getByTestId(`terminal-pane-${ids[0]}`)).toBeVisible();
		await expect(page.getByTestId(`terminal-pane-${ids[1]}`)).toBeVisible();
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

		await waitForSavedLeaf(projectId, terminalId);

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
		await waitForSavedLeaf(projectId, terminalId);
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

	test("reviving both ended panes of a split adds no tabs", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { projectId, terminalId } = await openProjectWithTerminal(
			page,
			student.workspaceId,
			"Revived split",
		);
		await paneAction(page, terminalId, "split-right");
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(2);
		const [, second] = await terminalIds(student.workspaceId, projectId);
		if (!second) throw new Error("the second terminal row was not created");

		// The split has to reach the saved layout before the reload, or the
		// reload rebuilds two tabs instead of one (SPEC.md §7.5).
		await waitForSavedLeaf(projectId, second);

		// What stopping the workspace does to both rows (SPEC.md §6.8, §9.7).
		await endTerminal(terminalId);
		await endTerminal(second);
		await page.reload();
		await expect(page.getByRole("button", { name: "New terminal here" })).toHaveCount(
			2,
			{ timeout: 15_000 },
		);

		await page.getByRole("button", { name: "New terminal here" }).first().click();
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(3);
		await page.getByRole("button", { name: "New terminal here" }).first().click();
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(4);

		const ids = await terminalIds(student.workspaceId, projectId);
		const revived = ids.filter((id) => id !== terminalId && id !== second);
		expect(revived).toHaveLength(2);

		// The two new terminals take the two panes of the one tab, and neither
		// they nor the ended rows they replaced get a tab of their own.
		for (const id of revived) {
			await expect(page.getByTestId(`terminal-leaf-${id}`)).toBeVisible({
				timeout: 15_000,
			});
		}
		await expect(page.getByTestId("work-tabs").getByRole("tab")).toHaveCount(1);
		for (const id of [second, ...revived]) {
			await expect(page.getByTestId(`tab-${id}`)).toHaveCount(0);
		}
		await expect(page.getByTestId(`terminal-leaf-${terminalId}`)).toHaveCount(0);
		await expect(page.getByTestId(`terminal-leaf-${second}`)).toHaveCount(0);
	});

	/** Panes are rearranged by dragging their title bars (SPEC.md §8.3, §9.3). */
	function splits(page: Page, direction: "row" | "column") {
		return page.locator(`[data-group][data-direction="${direction}"]`);
	}

	/** The panes of the visible tab, in the order they are laid out. */
	async function paneOrder(page: Page): Promise<string[]> {
		const ids = await page
			.locator(
				'[data-testid^="terminal-group-"]:not([hidden]) [data-testid^="terminal-leaf-"]',
			)
			.evaluateAll((nodes) =>
				nodes.map((node) => node.getAttribute("data-testid") ?? ""),
			);
		return ids.map((id) => id.replace("terminal-leaf-", ""));
	}

	/**
	 * Drag one pane's title bar to a point, in several steps so the 4px
	 * activation distance is crossed and dnd-kit sees the move.
	 */
	async function dragPane(
		page: Page,
		terminalId: string,
		to: { x: number; y: number },
		midDrag?: () => Promise<void>,
	): Promise<void> {
		const handle = page.getByTestId(`terminal-handle-${terminalId}`);
		const box = await handle.boundingBox();
		if (!box) throw new Error("the pane has no title bar to drag");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(to.x, to.y, { steps: 12 });
		await page.mouse.move(to.x, to.y, { steps: 2 });
		if (midDrag) await midDrag();
		await page.mouse.up();
	}

	/** A point inside one pane, given as fractions of its box. */
	async function pointIn(
		page: Page,
		terminalId: string,
		across: number,
		down: number,
	): Promise<{ x: number; y: number }> {
		const box = await page.getByTestId(`terminal-leaf-${terminalId}`).boundingBox();
		if (!box) throw new Error("the pane is not on screen");
		return { x: box.x + box.width * across, y: box.y + box.height * down };
	}

	/**
	 * Wait for the debounced save to hold a split running this way, so a
	 * reload reads what the drag produced rather than what came before it.
	 */
	async function waitForSavedDirection(
		projectId: string,
		direction: "row" | "column",
	): Promise<void> {
		await expect
			.poll(
				async () => {
					const rows = await query<{ layout: unknown }>(
						"select layout from projects where id = $1",
						[projectId],
					);
					return JSON.stringify(rows[0]?.layout ?? null).includes(
						`"direction":"${direction}"`,
					);
				},
				{ timeout: 10_000 },
			)
			.toBe(true);
	}

	test("a bottom pane dragged to the right edge becomes a vertical split", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { projectId, terminalId } = await openProjectWithTerminal(
			page,
			student.workspaceId,
			"Dragged",
		);
		await paneAction(page, terminalId, "split-down");
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(2);
		const [, second] = await terminalIds(student.workspaceId, projectId);
		await expectConnected(page, second as string);
		await expect(splits(page, "column")).toHaveCount(1);

		await dragPane(
			page,
			second as string,
			await pointIn(page, terminalId, 0.9, 0.5),
			async () => {
				// The hovered pane shades the half the drop would take.
				await expect(page.getByTestId(`drop-zone-${terminalId}`)).toHaveAttribute(
					"data-edge",
					"right",
				);
				await page.screenshot({ path: "screenshots/pane-drop-zone.png" });
			},
		);

		await expect(splits(page, "row")).toHaveCount(1);
		await expect(splits(page, "column")).toHaveCount(0);
		expect(await paneOrder(page)).toEqual([terminalId, second]);

		await waitForSavedDirection(projectId, "row");
		await page.reload();
		await expect(splits(page, "row")).toHaveCount(1, { timeout: 15_000 });
		await expect(splits(page, "column")).toHaveCount(0);
	});

	test("a right-hand pane dragged to the bottom edge becomes a stacked split", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { projectId, terminalId } = await openProjectWithTerminal(
			page,
			student.workspaceId,
			"Restacked",
		);
		await paneAction(page, terminalId, "split-right");
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(2);
		const [, second] = await terminalIds(student.workspaceId, projectId);
		await expectConnected(page, second as string);
		await expect(splits(page, "row")).toHaveCount(1);

		await dragPane(page, second as string, await pointIn(page, terminalId, 0.5, 0.92));

		await expect(splits(page, "column")).toHaveCount(1);
		await expect(splits(page, "row")).toHaveCount(0);
		expect(await paneOrder(page)).toEqual([terminalId, second]);
	});

	test("dropping on the centre swaps the two panes", async ({ page, context }) => {
		const student = await createStudent(context);
		const { projectId, terminalId } = await openProjectWithTerminal(
			page,
			student.workspaceId,
			"Swapped",
		);
		await paneAction(page, terminalId, "split-right");
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(2);
		const [, second] = await terminalIds(student.workspaceId, projectId);
		await expectConnected(page, second as string);
		expect(await paneOrder(page)).toEqual([terminalId, second]);

		// Each pane stamps a fresh id when it mounts, so an unchanged stamp
		// means the terminal was not torn down and reconnected.
		const mountIds = async () =>
			Promise.all(
				[terminalId, second as string].map((id) =>
					page.getByTestId(`terminal-leaf-${id}`).getAttribute("data-mount-id"),
				),
			);
		const before = await mountIds();

		await dragPane(page, second as string, await pointIn(page, terminalId, 0.5, 0.5));

		// The shape is untouched; the two panes traded places.
		await expect(splits(page, "row")).toHaveCount(1);
		expect(await paneOrder(page)).toEqual([second, terminalId]);
		// Swapping moves the panes, it does not remount them (SPEC.md §9.3).
		expect(await mountIds()).toEqual(before);
	});

	test("a pane dragged to the tab bar becomes its own tab", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { projectId, terminalId } = await openProjectWithTerminal(
			page,
			student.workspaceId,
			"Torn off",
		);
		await paneAction(page, terminalId, "split-right");
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(2);
		const [, second] = await terminalIds(student.workspaceId, projectId);
		await expectConnected(page, second as string);
		const tabs = page.getByTestId("work-tabs").getByRole("tab");
		await expect(tabs).toHaveCount(1);

		const strip = await page.getByTestId("work-tabs").boundingBox();
		if (!strip) throw new Error("the tab strip is not on screen");
		await dragPane(
			page,
			second as string,
			{ x: strip.x + strip.width - 40, y: strip.y + strip.height / 2 },
			async () => {
				await expect(page.getByTestId("tab-insert-marker")).toBeVisible();
			},
		);

		await expect(tabs).toHaveCount(2);
		expect(await paneOrder(page)).toEqual([second]);
		// The pane left the tab it came from, which now shows one terminal.
		await page.getByTestId(`tab-${terminalId}`).click();
		expect(await paneOrder(page)).toEqual([terminalId]);
		await expect(splits(page, "row")).toHaveCount(0);
	});

	test("a pane dragged back out of the tab it named gets its own tab id", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { projectId, terminalId } = await openProjectWithTerminal(
			page,
			student.workspaceId,
			"Renamed tabs",
		);
		// The one tab is named after this first terminal. Splitting puts a
		// second pane in it, so the tab's name and one of its panes differ.
		await paneAction(page, terminalId, "split-right");
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, projectId)).length)
			.toBe(2);
		const [, second] = await terminalIds(student.workspaceId, projectId);
		if (!second) throw new Error("the second terminal row was not created");
		await expectConnected(page, second);
		const tabs = page.getByTestId("work-tabs").getByRole("tab");
		await expect(tabs).toHaveCount(1);

		// Pull the first pane out to the strip. The new tab needs an id of its
		// own; reusing the terminal id would make two tabs called the same.
		const strip = await page.getByTestId("work-tabs").boundingBox();
		if (!strip) throw new Error("the tab strip is not on screen");
		await dragPane(page, terminalId, {
			x: strip.x + strip.width - 40,
			y: strip.y + strip.height / 2,
		});

		await expect(tabs).toHaveCount(2);
		const ids = await tabs.evaluateAll((nodes) =>
			nodes.map((node) => node.getAttribute("data-testid") ?? ""),
		);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("a saved file tab survives a reload and closing removes it", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Files" });
		// Seed the layout the file editor will write (SPEC.md §7.5, §8.3).
		const saved = {
			tabs: [{ id: "file:src/app.ts", root: { type: "file", path: "src/app.ts" } }],
		};
		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify(saved),
		]);

		await page.goto(workspacePath(student.workspaceId, project.id));
		const tab = page.getByTestId("tab-file:src/app.ts");
		// The strip shows the file name, with the whole path on hover.
		await expect(tab).toBeVisible({ timeout: 15_000 });
		await expect(tab).toContainText("app.ts");
		await expect(tab).toHaveAttribute("title", "src/app.ts");
		await expect(page.getByTestId("file-pane-src/app.ts")).toBeVisible();

		await page.reload();
		await expect(page.getByTestId("tab-file:src/app.ts")).toBeVisible({
			timeout: 15_000,
		});

		// The tab holds no terminal, so closing it asks nothing and just drops it.
		await page.getByTestId("tab-file:src/app.ts-close").click();
		await expect(page.getByTestId("tab-file:src/app.ts")).toHaveCount(0);
		await expect
			.poll(
				async () => {
					const rows = await query<{ layout: unknown }>(
						"select layout from projects where id = $1",
						[project.id],
					);
					return JSON.stringify(rows[0]?.layout ?? null).includes("src/app.ts");
				},
				{ timeout: 10_000 },
			)
			.toBe(false);
	});
	/**
	 * Leaving the workspace route and coming back keeps the selected tab and
	 * the editor's cursor and scroll position (issue #161).
	 */
	test("the selected tab and the cursor come back after a round trip", async ({
		page,
		context,
	}) => {
		// Monaco's first load in a run is slow.
		test.setTimeout(120_000);
		const path = "src/long.ts";
		const content = `${Array.from(
			{ length: 200 },
			(_, index) => `const line${index + 1} = ${index + 1};`,
		).join("\n")}`;
		const student = await createStudent(context);
		const project = await openFileTab(page, student, "Restore", path, content);
		const editor = page.getByTestId(`editor-${path}`);
		await expect(editor.locator(".view-lines")).toContainText("const line1 = 1;", {
			timeout: 60_000,
		});

		// A second tab, so the remembered one is not simply the first.
		await newTerminal(page);
		await expect(page.getByTestId("work-tabs").getByRole("tab")).toHaveCount(2, {
			timeout: 15_000,
		});
		const [terminalId] = await terminalIds(student.workspaceId, project.id);
		if (!terminalId) throw new Error("the terminal row was not created");
		await waitForSavedLeaf(project.id, terminalId);

		// Put the cursor at the end of the file, which also scrolls there.
		await page.getByTestId(`tab-file:${path}`).click();
		await editor.locator(".view-lines").click();
		await page.keyboard.press("Control+End");
		const activeLine = editor.locator(".active-line-number");
		await expect(activeLine).toHaveText("200");

		// The terminal tab is the one selected when the student leaves.
		await page.getByTestId(`tab-${terminalId}`).click();
		await expect(page.getByTestId(`tab-${terminalId}`)).toHaveAttribute(
			"data-state",
			"active",
		);

		await page.goto(workspacePath(student.workspaceId));
		await expect(page.getByTestId("project-list")).toBeVisible({ timeout: 15_000 });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId("work-tabs").getByRole("tab")).toHaveCount(2, {
			timeout: 15_000,
		});

		await expect(page.getByTestId(`tab-${terminalId}`)).toHaveAttribute(
			"data-state",
			"active",
			{ timeout: 15_000 },
		);
		await page.getByTestId(`tab-file:${path}`).click();
		await expect(activeLine).toHaveText("200", { timeout: 30_000 });
	});
});

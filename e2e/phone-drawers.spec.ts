import { expect, type Locator, type Page, test } from "@playwright/test";
import { makeChatTab, scriptedChat } from "./chat-helpers";
import {
	createProject,
	createStudent,
	expectNoViolations,
	seedFile,
	workspacePath,
	workTabs,
} from "./helpers";

/**
 * Below 56rem the work area fills the screen and the two side panes are
 * slide-over drawers opened from the header (SPEC.md section 8.1): each is a
 * named modal dialog that keeps focus inside, closes on Escape, a tap
 * outside, its close button or a choice that shows the work area, and hands
 * focus back to the button that opened it (SPEC.md section 25.8).
 */

const WIDTHS = [360, 420, 800];
const HEIGHT = 760;

async function boxOf(locator: Locator) {
	const box = await locator.boundingBox();
	if (!box) throw new Error("the element has no box");
	return box;
}

/** True when focus is on an element inside `container`. */
function focusIsIn(container: Locator): Promise<boolean> {
	return container.evaluate((el) => el.contains(document.activeElement));
}

function drawers(page: Page) {
	return {
		projectsButton: page.getByRole("button", {
			name: "Projects",
			exact: true,
			includeHidden: true,
		}),
		filesButton: page.getByRole("button", {
			name: "Files",
			exact: true,
			includeHidden: true,
		}),
		projects: page.getByRole("dialog", { name: "Projects" }),
		files: page.getByRole("dialog", { name: "Files" }),
	};
}

for (const width of WIDTHS) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`at ${width} px (${colorScheme})`, () => {
			test.use({
				viewport: { width, height: HEIGHT },
				colorScheme,
				hasTouch: true,
			});

			test("the work area fills the screen and each drawer opens and closes by touch and keyboard", async ({
				page,
				context,
			}) => {
				const student = await createStudent(context);
				const project = await createProject(student.workspaceId, { name: "Phone" });
				const other = await createProject(student.workspaceId, { name: "Other" });
				await seedFile(student.workspaceId, project.slug, "notes.md", "# notes\n");
				await page.goto(workspacePath(student.workspaceId, project.id));
				await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
				const d = drawers(page);

				// The work area takes the whole width; the panes and their handles are gone.
				const work = await boxOf(page.getByRole("main", { name: "Work area" }));
				expect(work.x).toBe(0);
				expect(work.width).toBe(width);
				await expect(page.getByRole("navigation", { name: "Projects" })).toBeHidden();
				await expect(page.getByRole("tab", { name: "Checks" })).toBeHidden();
				await expect(
					page.getByRole("separator", { name: "Resize project list" }),
				).toBeHidden();
				const widths = await page.evaluate(() => ({
					scroll: document.documentElement.scrollWidth,
					client: document.documentElement.clientWidth,
				}));
				expect(widths.scroll).toBeLessThanOrEqual(widths.client);
				await expect(d.projectsButton).toHaveAttribute("aria-expanded", "false");
				await expectNoViolations(page);

				// Projects by touch: it slides in from the left, named, focus on its close button.
				await d.projectsButton.tap();
				await expect(d.projects).toBeVisible();
				await expect(d.projectsButton).toHaveAttribute("aria-expanded", "true");
				// Once the slide in has finished.
				await expect.poll(async () => (await boxOf(d.projects)).x).toBe(0);
				expect((await boxOf(d.projects)).width).toBeLessThan(width);
				await expect(d.projects).toBeFocused();
				await page.keyboard.press("Tab");
				await expect(
					d.projects.getByRole("button", { name: "Close projects" }),
				).toBeFocused();
				await expect(d.projects.getByRole("link", { name: "Other" })).toBeVisible();
				await expectNoViolations(page);
				// Focus stays inside while it is open.
				for (let step = 0; step < 8; step += 1) {
					await page.keyboard.press("Tab");
					expect(await focusIsIn(d.projects)).toBe(true);
				}
				// A tap on the work area left showing closes it.
				await page.touchscreen.tap(width - 8, HEIGHT / 2);
				await expect(d.projects).toBeHidden();
				await expect(d.projectsButton).toBeFocused();

				// By keyboard; Escape closes and returns focus.
				await page.keyboard.press("Enter");
				await expect(d.projects).toBeVisible();
				await page.keyboard.press("Escape");
				await expect(d.projects).toBeHidden();
				await expect(d.projectsButton).toBeFocused();

				await d.filesButton.focus();
				await page.keyboard.press("Enter");
				await expect(d.files).toBeVisible();
				await expect
					.poll(async () => {
						const files = await boxOf(d.files);
						return Math.round(files.x + files.width);
					})
					.toBe(width);
				await expect(d.files.getByRole("tab", { name: "Files" })).toBeVisible();
				await expect(d.files.getByRole("tab", { name: "Checks" })).toBeVisible();
				await expectNoViolations(page);
				// The close button by keyboard.
				await d.files.getByRole("button", { name: "Close files" }).focus();
				await page.keyboard.press("Enter");
				await expect(d.files).toBeHidden();
				await expect(d.filesButton).toBeFocused();

				// Opening a file shows it in the work area and closes the drawer.
				await d.filesButton.tap();
				await d.files.getByTestId("file-row-notes.md").tap();
				await expect(d.files).toBeHidden();
				await expect(page.getByTestId("tab-file:notes.md")).toBeVisible();
				await expect(d.filesButton).toBeFocused();

				// Choosing a project closes the drawer on the new project.
				await d.projectsButton.tap();
				await d.projects.getByRole("link", { name: "Other" }).tap();
				await expect(d.projects).toBeHidden();
				await expect(page).toHaveURL(new RegExp(`/projects/${other.id}$`));
				await expect(d.projectsButton).toBeFocused();
			});
		});
	}
}

for (const width of WIDTHS) {
	test.describe(`a chat at ${width} px`, () => {
		test.use({ viewport: { width, height: HEIGHT } });

		test("the composer shows whole, and opening and closing a drawer leaves it as it was", async ({
			page,
			context,
		}) => {
			const made = await makeChatTab(page, context);
			await page.routeWebSocket(/\/chat$/, (ws) => {
				const send = scriptedChat(ws, "00000000-0000-4000-8000-000000000000");
				send("snapshot", { cards: [], turnRunning: false, truncated: false });
				send("settings", {
					agent: "claude",
					model: "default",
					effort: "high",
					mode: "default",
				});
			});
			await page.reload();
			const view = page.getByTestId(`chat-view-${made.id}`);
			const input = view.getByTestId("chat-composer-input");
			await expect(input).toBeVisible({ timeout: 15_000 });
			const composer = await boxOf(view.locator(".pk-chat-composer"));
			const status = await boxOf(page.getByRole("contentinfo"));
			expect(composer.x).toBeGreaterThanOrEqual(0);
			expect(composer.x + composer.width).toBeLessThanOrEqual(width);
			expect(composer.y + composer.height).toBeLessThanOrEqual(status.y + 1);

			await input.fill("half a thought");
			const d = drawers(page);
			await d.filesButton.click();
			await expect(d.files).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(d.files).toBeHidden();
			expect(await boxOf(view.locator(".pk-chat-composer"))).toEqual(composer);
			await expect(input).toHaveText("half a thought");
		});
	});
}

test.describe("a right-pane surface asked for at 360 px", () => {
	test.use({ viewport: { width: 360, height: HEIGHT } });

	test("the memory meter opens the Files drawer on Monitor", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await page.goto(workspacePath(student.workspaceId));
		const meter = page.getByTestId("memory-meter");
		await expect(meter).toBeVisible({ timeout: 15_000 });
		await meter.click();
		const d = drawers(page);
		await expect(d.files).toBeVisible();
		await expect(d.files.getByRole("tab", { name: "Monitor" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await page.keyboard.press("Escape");
		await expect(d.files).toBeHidden();
	});
});

test.describe("at 1024 px", () => {
	test.use({ viewport: { width: 1024, height: HEIGHT } });

	test("the three panes stay side by side and there are no drawer buttons", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Wide" });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
		const d = drawers(page);
		await expect(d.projectsButton).toBeHidden();
		await expect(d.filesButton).toBeHidden();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		const projects = await boxOf(page.getByRole("navigation", { name: "Projects" }));
		const work = await boxOf(page.getByRole("main", { name: "Work area" }));
		const files = await boxOf(page.locator(".pk-right-pane"));
		expect(projects.x + projects.width).toBeLessThanOrEqual(work.x + 1);
		expect(work.x + work.width).toBeLessThanOrEqual(files.x + 1);
	});
});

for (const width of [360, 800]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`behind an open drawer at ${width} px (${colorScheme})`, () => {
			test.use({ viewport: { width, height: HEIGHT }, colorScheme });

			test("the chat's announcer still speaks: the page is hidden with aria-hidden, not inert (ADR 0047)", async ({
				page,
				context,
			}) => {
				const made = await makeChatTab(page, context);
				let send: ReturnType<typeof scriptedChat> | undefined;
				await page.routeWebSocket(/\/chat$/, (ws) => {
					send = scriptedChat(ws, "00000000-0000-4000-8000-000000000000");
					send("snapshot", { cards: [], turnRunning: true, truncated: false });
					send("settings", {
						agent: "claude",
						model: "default",
						effort: "high",
						mode: "default",
					});
				});
				await page.reload();
				const view = page.getByTestId(`chat-view-${made.id}`);
				await expect(view.getByTestId("chat-composer-input")).toBeVisible({
					timeout: 15_000,
				});
				const announcer = view.getByTestId("chat-announcer");
				await expect(announcer).toHaveText("Claude is working.");

				const d = drawers(page);
				await d.filesButton.click();
				await expect(d.files).toBeVisible();
				expect(await page.locator("[inert]").count()).toBe(0);
				// The header behind is hidden from the screen reader; the live region below stays heard.
				await expect(
					page.getByRole("button", { name: "Projects", exact: true }),
				).toHaveCount(0);
				send?.("permission.requested", {
					id: "p1",
					toolName: "Bash",
					title: "ls",
					input: { command: "ls" },
					options: [{ id: "allow", label: "Allow once" }],
				});
				await expect(announcer).toHaveText("Claude wants to use Bash.");
				expect(
					await announcer.evaluate((el) => el.closest('[aria-hidden="true"]') === null),
				).toBe(true);
				await expect(d.files).toBeVisible();
				await expectNoViolations(page);

				await page.keyboard.press("Escape");
				await expect(d.files).toBeHidden();
				await expect(page.getByRole("main", { name: "Work area" })).toBeVisible();
			});

			test("going to another project closes whichever drawer is open, and a tab closing on its own does not", async ({
				page,
				context,
			}) => {
				const student = await createStudent(context);
				const first = await createProject(student.workspaceId, { name: "First" });
				const second = await createProject(student.workspaceId, { name: "Second" });
				await seedFile(student.workspaceId, second.slug, "a.md", "# a\n");
				await seedFile(student.workspaceId, second.slug, "b.md", "# b\n");
				await page.goto(workspacePath(student.workspaceId, first.id));
				await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
				const d = drawers(page);
				await d.projectsButton.click();
				await d.projects.getByRole("link", { name: "Second" }).click();
				await expect(page).toHaveURL(new RegExp(`/projects/${second.id}$`));

				// Two files open, then the Files drawer stays open while one is deleted.
				for (const name of ["a.md", "b.md"]) {
					await d.filesButton.click();
					await d.files.getByTestId(`file-row-${name}`).click();
					await expect(d.files).toBeHidden();
				}
				await d.filesButton.click();
				await d.files.getByTestId("file-row-b.md").click({ button: "right" });
				await page.getByRole("menuitem", { name: /Delete/ }).click();
				await page
					.getByRole("alertdialog")
					.getByRole("button", { name: "Delete" })
					.click();
				await expect(page.getByTestId("tab-file:b.md")).toHaveCount(0);
				await expect(d.files).toBeVisible();
				await expectNoViolations(page);

				// Back to the first project with Files open: it closes, focus on its button.
				await page.goBack();
				await expect(page).toHaveURL(new RegExp(`/projects/${first.id}$`));
				await expect(d.files).toBeHidden();
				await expect(d.filesButton).toBeFocused();
			});

			test("widening the window with a drawer open puts focus in the pane it held", async ({
				page,
				context,
			}) => {
				const student = await createStudent(context);
				const project = await createProject(student.workspaceId, { name: "Widen" });
				await page.goto(workspacePath(student.workspaceId, project.id));
				await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
				const d = drawers(page);

				await d.projectsButton.click();
				await expect(d.projects).toBeVisible();
				await expectNoViolations(page);
				await page.setViewportSize({ width: 1024, height: HEIGHT });
				const projects = page.getByRole("navigation", { name: "Projects" });
				await expect(projects).toBeVisible();
				await expect.poll(() => focusIsIn(projects)).toBe(true);

				await page.setViewportSize({ width, height: HEIGHT });
				await d.filesButton.click();
				await expect(d.files).toBeVisible();
				await page.setViewportSize({ width: 1024, height: HEIGHT });
				await expect(
					page.getByRole("tab", { name: "Files", selected: true }),
				).toBeFocused();
			});
		});
	}
}

import { expect, type Page, test } from "@playwright/test";
import { openChat } from "./chat-helpers";
import { colourOf, expectEvenRing } from "./focus-ring-helpers";
import {
	createProject,
	createStudent,
	expectConnected,
	query,
	seedFile,
	terminalIds,
	workspacePath,
} from "./helpers";
import { splitPane } from "./split-helpers";

/**
 * The pane that has the keyboard, in a tab with more than one pane, wears
 * a focus ring of one even width all the way round: top, bottom and both
 * sides, whatever the pane holds, wherever it sits in the split and at any
 * zoom (SPEC.md §25.8 visible focus, §13.1 zoom). Measured from the screen,
 * so a child or a splitter painting over the ring fails.
 */

async function zoomTo(page: Page, paneId: string, percent: number): Promise<void> {
	const value = page.getByTestId(`pane-zoom-${paneId}`);
	const now = Number.parseInt((await value.textContent()) ?? "100", 10);
	const button = percent > now ? "in" : "out";
	for (let step = 0; step < Math.abs(percent - now) / 10; step += 1) {
		await page.getByTestId(`pane-zoom-${button}-${paneId}`).click();
	}
	await expect(value).toHaveText(`${percent}%`);
}

/** The id of the one pane that is not in `known`, once it exists. */
async function newPane(workspaceId: string, projectId: string, known: string[]) {
	await expect
		.poll(async () => (await terminalIds(workspaceId, projectId)).length)
		.toBe(known.length + 1);
	const id = (await terminalIds(workspaceId, projectId)).find(
		(one) => !known.includes(one),
	);
	if (!id) throw new Error("the split's pane was not created");
	return id;
}

for (const theme of ["dark", "light"] as const) {
	test(`the focused pane's ring is even on all four edges, for chats and terminals anywhere in a split, at every zoom, in the ${theme} theme`, async ({
		page,
		context,
	}) => {
		await context.addInitScript((value) => {
			localStorage.setItem("pk-theme", value);
		}, theme);
		const student = await createStudent(context);
		const {
			project,
			id: chat,
			view,
		} = await openChat(page, student.workspaceId, "Ring");
		await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

		// A chat on the left, a terminal on the right.
		await splitPane(page, chat, "right");
		const shell = await newPane(student.workspaceId, project.id, [chat]);
		await expectConnected(page, shell);

		// A chat follows the page's theme, so its ring takes the page's focus colour.
		const chatPane = page.getByTestId(`terminal-leaf-${chat}`);
		expect(await colourOf(chatPane, "--focus")).toEqual(
			await colourOf(page.locator("html"), "--focus"),
		);

		for (const percent of [100, 50, 150, 200]) {
			await zoomTo(page, chat, percent);
			await view.getByTestId("chat-composer-input").click();
			await expectEvenRing(page, chatPane);
		}

		const shellPane = page.getByTestId(`terminal-leaf-${shell}`);
		await shellPane.locator(".xterm").click();
		await expect(chatPane).not.toHaveClass(/is-focused/);
		await expectEvenRing(page, shellPane);

		// A chat under the terminal, on the right and below a splitter.
		await splitPane(page, shell, "down", "claude-gui");
		const lower = await newPane(student.workspaceId, project.id, [chat, shell]);
		const lowerView = page.getByTestId(`chat-view-${lower}`);
		await expect(lowerView.getByTestId("chat-composer-input")).toBeVisible({
			timeout: 15_000,
		});
		const lowerPane = page.getByTestId(`terminal-leaf-${lower}`);
		for (const percent of [100, 50, 150, 200]) {
			await zoomTo(page, lower, percent);
			await lowerView.getByTestId("chat-composer-input").click();
			await expectEvenRing(page, lowerPane);
		}
		await shellPane.locator(".xterm").click();
		await expectEvenRing(page, shellPane);
	});
}

for (const theme of ["dark", "light"] as const) {
	test(`the focused editor pane's ring is even on all four edges, on either side of a split, in the ${theme} theme`, async ({
		page,
		context,
	}) => {
		// Monaco is a large chunk the dev server transforms on first use.
		test.setTimeout(90_000);
		await context.addInitScript((value) => {
			localStorage.setItem("pk-theme", value);
		}, theme);
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Editor Ring" });
		const left = "src/left.ts";
		const right = "src/right.ts";
		await seedFile(student.workspaceId, project.slug, left, "const left = 1;\n");
		await seedFile(student.workspaceId, project.slug, right, "const right = 2;\n");
		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify({
				tabs: [
					{
						id: "editor-split",
						root: {
							type: "split",
							direction: "row",
							sizes: [50, 50],
							children: [
								{ type: "file", path: left },
								{ type: "file", path: right },
							],
						},
					},
				],
			}),
		]);
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
		const lines = (path: string) =>
			page.getByTestId(`editor-${path}`).locator(".view-lines");
		await expect(lines(left)).toContainText("const left = 1;", { timeout: 60_000 });
		await expect(lines(right)).toContainText("const right = 2;", { timeout: 60_000 });

		const leftPane = page.getByTestId(`file-frame-${left}`);
		const rightPane = page.getByTestId(`file-frame-${right}`);
		// An editor follows the page's theme, so its ring takes the page's focus colour.
		expect(await colourOf(leftPane, "--focus")).toEqual(
			await colourOf(page.locator("html"), "--focus"),
		);

		await lines(left).click();
		await expectEvenRing(page, leftPane);
		await expect(rightPane).not.toHaveClass(/is-focused/);

		await lines(right).click();
		await expectEvenRing(page, rightPane);
		await expect(leftPane).not.toHaveClass(/is-focused/);
	});
}

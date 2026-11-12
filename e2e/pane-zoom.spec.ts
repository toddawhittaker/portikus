import { expect, type Locator, type Page, test } from "@playwright/test";
import { launchChat, openChat } from "./chat-helpers";
import {
	createProject,
	createStudent,
	expectConnected,
	expectNoViolations,
	newTerminal,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";
import { splitPane } from "./split-helpers";

/**
 * Each terminal and chat pane zooms on its own, from 50% to 300% in 10%
 * steps. Ctrl + wheel, or a trackpad pinch, zooms the pane under the pointer
 * and never the page. A chat takes the editor's zoom keys; a terminal leaves
 * them to the shell. A pane keeps its zoom through a split (SPEC.md §13.1,
 * §20.1).
 */

function zoomValue(page: Page, paneId: string): Locator {
	return page.getByTestId(`pane-zoom-${paneId}`);
}

/** The pane's polite status region, which the zoom buttons and keys write to. */
function zoomStatus(page: Page, paneId: string): Locator {
	return page.getByTestId(`pane-zoom-status-${paneId}`);
}

/** The pixel size xterm.js draws a terminal's rows at. */
async function terminalFontSize(page: Page, paneId: string): Promise<string> {
	return page
		.getByTestId(`terminal-pane-${paneId}`)
		.locator(".xterm-rows")
		.evaluate((node) => getComputedStyle(node).fontSize);
}

/** Turn the wheel once with Ctrl held, over the middle of `target`. */
async function ctrlWheel(page: Page, target: Locator, deltaY: number): Promise<void> {
	const box = await target.boundingBox();
	if (!box) throw new Error("the pane has no box");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.keyboard.down("Control");
	await page.mouse.wheel(0, deltaY);
	await page.keyboard.up("Control");
}

/** The id of the one terminal that is not in `known`, once it exists. */
async function newId(workspaceId: string, projectId: string, known: string[]) {
	await expect
		.poll(async () => (await terminalIds(workspaceId, projectId)).length)
		.toBe(known.length + 1);
	const id = (await terminalIds(workspaceId, projectId)).find(
		(one) => !known.includes(one),
	);
	if (!id) throw new Error("the split's terminal was not created");
	return id;
}

/** Every resize frame the page sends, by terminal. */
function recordSizes(page: Page): { terminalId: string; cols: number }[] {
	const sizes: { terminalId: string; cols: number }[] = [];
	page.on("websocket", (socket) => {
		const terminalId = /\/terminals\/([^/]+)\/ws/.exec(socket.url())?.[1];
		if (!terminalId) return;
		socket.on("framesent", ({ payload }) => {
			if (typeof payload !== "string" || !payload.includes('"resize"')) return;
			sizes.push({ terminalId, cols: (JSON.parse(payload) as { cols: number }).cols });
		});
	});
	return sizes;
}

test("Ctrl + wheel over an unfocused terminal zooms only that terminal, never the page", async ({
	page,
	context,
}) => {
	const sizes = recordSizes(page);
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Zoom" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	const first = await newId(student.workspaceId, project.id, []);
	await expectConnected(page, first);
	await splitPane(page, first, "right");
	const second = await newId(student.workspaceId, project.id, [first]);
	await expectConnected(page, second);

	// The keyboard is in the new pane; the wheel turns over the first.
	await expect(
		page
			.getByTestId(`terminal-pane-${second}`)
			.locator("textarea.xterm-helper-textarea"),
	).toBeFocused();
	const startSize = "14px";
	await expect.poll(() => terminalFontSize(page, first)).toBe(startSize);
	const pageRatio = await page.evaluate(() => window.devicePixelRatio);
	const pageWheels = await page.evaluateHandle(() => {
		const seen = { prevented: [] as boolean[] };
		// Read once the event has been through the page: the pane stops it on
		// the way down, so only a capturing listener here sees it at all.
		window.addEventListener(
			"wheel",
			(event) => setTimeout(() => seen.prevented.push(event.defaultPrevented)),
			{ capture: true },
		);
		return seen;
	});

	await ctrlWheel(page, page.getByTestId(`terminal-pane-${first}`), -100);
	await expect(zoomValue(page, first)).toHaveText("110%");
	await expect(zoomValue(page, second)).toHaveText("100%");
	// xterm.js draws the new size on its next frame. 14 px at 110% is 15 px.
	await expect.poll(() => terminalFontSize(page, first)).toBe("15px");
	expect(await terminalFontSize(page, second)).toBe(startSize);
	// The pane took the event, so the browser did not zoom the page.
	expect(await pageWheels.evaluate((seen) => seen.prevented)).toEqual([true]);
	expect(await page.evaluate(() => window.devicePixelRatio)).toBe(pageRatio);

	// The bigger cells make a narrower grid, and tmux is told.
	const before = sizes.filter((size) => size.terminalId === first).at(-1)?.cols ?? 0;
	await ctrlWheel(page, page.getByTestId(`terminal-pane-${first}`), -100);
	await expect(zoomValue(page, first)).toHaveText("120%");
	// The wheel and a pinch fire many times in a gesture, so they say nothing.
	await expect(zoomStatus(page, first)).toHaveText("");
	await expect
		.poll(() => sizes.filter((size) => size.terminalId === first).at(-1)?.cols ?? 0)
		.toBeLessThan(before);

	// The shell keeps Ctrl+= and Ctrl+-: the editor's keys do not zoom a terminal.
	await page.getByTestId(`terminal-pane-${first}`).click();
	await page.keyboard.press("Control+Shift+Equal");
	await page.keyboard.press("Control+0");
	await expect(zoomValue(page, first)).toHaveText("120%");

	// The pane's buttons step it and bring it back to 100%.
	await page
		.getByRole("button", { name: /^Zoom Terminal \d+ out$/ })
		.first()
		.click();
	await expect(zoomValue(page, first)).toHaveText("110%");
	await expect(zoomStatus(page, first)).toHaveText(/^Terminal \d+ zoom 110%$/);
	await zoomValue(page, first).click();
	await expect(zoomValue(page, first)).toHaveText("100%");
	await expect.poll(() => terminalFontSize(page, first)).toBe(startSize);
});

test("two chats keep different sizes, by keys and by buttons", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const {
		project,
		id: left,
		view: leftView,
	} = await openChat(page, student.workspaceId, "Chats");
	await splitPane(page, left, "right", "claude-gui");
	const right = await newId(student.workspaceId, project.id, [left]);
	const rightView = page.getByTestId(`chat-view-${right}`);
	await expect(rightView.getByTestId("chat-composer-input")).toBeVisible({
		timeout: 15_000,
	});

	// The editor's keys zoom the chat the keyboard is in.
	await leftView.getByTestId("chat-composer-input").click();
	await page.keyboard.press("Control+Shift+Equal");
	await page.keyboard.press("Control+Shift+Equal");
	await expect(zoomValue(page, left)).toHaveText("120%");
	await expect(zoomStatus(page, left)).toHaveText(/ zoom 120%$/);
	await page.getByTestId(`pane-zoom-out-${right}`).click();
	await page.getByTestId(`pane-zoom-out-${right}`).click();
	await expect(zoomValue(page, right)).toHaveText("80%");
	await expect(zoomStatus(page, right)).toHaveText(/ zoom 80%$/);
	await expect(zoomValue(page, left)).toHaveText("120%");

	const scale = (view: Locator) =>
		view.evaluate((node) => Number(getComputedStyle(node).zoom));
	expect(await scale(leftView)).toBeCloseTo(1.2);
	expect(await scale(rightView)).toBeCloseTo(0.8);
	// Type scales with the pane; the reading column stays its width on screen.
	const column = (view: Locator) =>
		view.evaluate((node) => {
			const probe = document.createElement("div");
			probe.style.inlineSize = "var(--pk-chat-column)";
			probe.style.position = "absolute";
			node.append(probe);
			const width = probe.getBoundingClientRect().width;
			probe.remove();
			return width;
		});
	expect(Math.round(await column(leftView))).toBe(Math.round(await column(rightView)));

	await leftView.getByTestId("chat-composer-input").click();
	await page.keyboard.press("Control+0");
	await expect(zoomValue(page, left)).toHaveText("100%");
	await expect(zoomValue(page, right)).toHaveText("80%");
});

test("a pane keeps its zoom through a split and leaving the workspace", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Keep" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	const shell = await newId(student.workspaceId, project.id, []);
	await expectConnected(page, shell);
	await page.getByTestId(`pane-zoom-in-${shell}`).click();
	await page.getByTestId(`pane-zoom-in-${shell}`).click();
	await page.getByTestId(`pane-zoom-in-${shell}`).click();
	await expect(zoomValue(page, shell)).toHaveText("130%");
	// 14 px at 130%.
	const zoomedSize = "18px";
	await expect.poll(() => terminalFontSize(page, shell)).toBe(zoomedSize);

	await splitPane(page, shell, "down");
	const below = await newId(student.workspaceId, project.id, [shell]);
	await expectConnected(page, below);
	await expect(zoomValue(page, shell)).toHaveText("130%");
	await expect(zoomValue(page, below)).toHaveText("100%");
	await expect.poll(() => terminalFontSize(page, shell)).toBe(zoomedSize);

	// A chat opened in a tab of its own starts at 100%.
	const { id: chat } = await launchChat(page, student.workspaceId, project.id);
	await expect(zoomValue(page, chat)).toHaveText("100%");

	// Leaving the workspace and coming back keeps it, for this browser session.
	await page.goto("/");
	await page.goto(workspacePath(student.workspaceId, project.id));
	await workTabs(page).getByRole("tab").first().click();
	await expect(zoomValue(page, shell)).toHaveText("130%");
});

for (const theme of ["dark", "light"] as const) {
	test(`the pane bar with its zoom buttons passes axe in the ${theme} theme`, async ({
		page,
		context,
	}) => {
		await context.addInitScript((value) => {
			localStorage.setItem("pk-theme", value);
		}, theme);
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Axe" });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
		await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
		await newTerminal(page);
		const shell = await newId(student.workspaceId, project.id, []);
		await expectConnected(page, shell);
		await page.getByTestId(`pane-zoom-in-${shell}`).click();
		await expect(zoomValue(page, shell)).toHaveText("110%");
		await expectNoViolations(
			page,
			`[data-testid="terminal-leaf-${shell}"] .pk-term-bar`,
		);
	});
}

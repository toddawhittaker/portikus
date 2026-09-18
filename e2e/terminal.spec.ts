import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	deleteSessions,
	endTerminal,
	expectConnected,
	newTerminal,
	projectIds,
	query,
	terminalIds,
	WEB_ORIGIN,
	waitForSavedLeaf,
	workspacePath,
	workTabs,
} from "./helpers";

/**
 * The workspace terminal screen (SPEC.md §6.7, §6.8, §9, §14.9). The fake
 * workspace agent echoes every frame it is sent back as output, prefixed
 * with "echo:", so anything typed shows up in the terminal.
 */

/** The tab strip and the pane of the terminal that is currently shown. */
function tabs(page: Page): Locator {
	return workTabs(page);
}

function visiblePane(page: Page): Locator {
	return page.locator(".pk-termgroup:not([hidden]) .pk-term");
}

function rowsOf(page: Page, terminalId: string): Locator {
	return page.locator(`[data-testid=terminal-pane-${terminalId}] .xterm-rows`);
}

/**
 * Type into the terminal that is on screen. `insertText` delivers the whole
 * string in one input event, so the agent sees one frame rather than one per
 * keystroke.
 */
async function typeInTerminal(page: Page, text: string): Promise<void> {
	await visiblePane(page).locator(".xterm-screen").click();
	await page.keyboard.insertText(text);
	await page.keyboard.press("Enter");
}

/**
 * Type and wait for the agent to echo it back. Anything typed before the
 * attachment finishes opening is dropped, the way keystrokes sent to a
 * terminal that is not attached yet are, so type again until it lands.
 */
async function typeAndExpectEcho(
	page: Page,
	rows: Locator,
	text: string,
): Promise<void> {
	await expect
		.poll(
			async () => {
				const seen = (await rows.textContent()) ?? "";
				if (seen.includes(text)) return seen;
				await typeInTerminal(page, text);
				await page.waitForTimeout(500);
				return (await rows.textContent()) ?? "";
			},
			{ timeout: 20_000, intervals: [200, 500, 1000, 2000] },
		)
		.toContain(text);
}

/**
 * Open a project's work area with one terminal ready, and return its id.
 * Every terminal belongs to a project now (SPEC.md §7.5, §9.4), so the
 * project is created first and the page goes to its route.
 */
async function openWithTerminal(page: Page, workspaceId: string): Promise<string> {
	const project = await createProject(workspaceId, { name: "Terminal Work" });
	await page.goto(workspacePath(workspaceId, project.id));
	await expect(tabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await expect(page.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
	const [id] = await terminalIds(workspaceId);
	if (!id) throw new Error("the terminal row was not created");
	await expect(visiblePane(page).locator(".xterm-screen")).toBeVisible();
	await expectConnected(page, id);
	return id;
}

test("a new terminal echoes what is typed into it", async ({ page, context }) => {
	const student = await createStudent(context);
	const terminalId = await openWithTerminal(page, student.workspaceId);

	await typeAndExpectEcho(page, rowsOf(page, terminalId), "echo hi");
});

test("terminals keep their own output, can be renamed and closed", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await openWithTerminal(page, student.workspaceId);
	await newTerminal(page);
	await expect(page.getByRole("tab", { name: "Terminal 2" })).toBeVisible();
	await newTerminal(page);
	await expect(page.getByRole("tab", { name: "Terminal 3" })).toBeVisible();

	const ids = await terminalIds(student.workspaceId);
	expect(ids).toHaveLength(3);
	const [first, second, third] = ids as [string, string, string];

	// The third tab is the one on screen, so type there first.
	await typeAndExpectEcho(page, rowsOf(page, third), "charlie");
	await page.getByRole("tab", { name: "Terminal 1" }).click();
	await typeAndExpectEcho(page, rowsOf(page, first), "alpha");

	await expect(rowsOf(page, first)).not.toContainText("charlie");
	await expect(rowsOf(page, third)).toContainText("charlie");
	await expect(rowsOf(page, third)).not.toContainText("alpha");
	await expect(rowsOf(page, second)).not.toContainText("alpha");

	// The pane's actions menu renames its terminal.
	await page.getByRole("tab", { name: "Terminal 2" }).click();
	await page.getByTestId(`terminal-actions-${second}`).click();
	await page.getByTestId("terminal-rename").click();
	const input = page.getByTestId("terminal-rename-field");
	await input.fill("Build");
	await input.press("Enter");
	await expect(page.getByRole("tab", { name: "Build" })).toBeVisible();

	// Closing a terminal is a user action, so its tab goes away (SPEC.md §9.3).
	await page.getByRole("button", { name: "Close Build" }).click();
	await expect(page.getByRole("tab", { name: "Build" })).toHaveCount(0);
	await expect(tabs(page).getByRole("tab")).toHaveCount(2);
	// The tab goes at once and the delete lands just after it.
	await expect
		.poll(async () => {
			const rows = await query<{ count: string }>(
				"select count(*)::text as count from terminals where workspace_id = $1",
				[student.workspaceId],
			);
			return rows[0]?.count;
		})
		.toBe("2");
});

test("a reload keeps the terminal and can attach to it again", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const terminalId = await openWithTerminal(page, student.workspaceId);

	await typeAndExpectEcho(page, rowsOf(page, terminalId), "before-reload");

	await page.reload();
	await expect(page.getByRole("tab", { name: "Terminal 1" })).toBeVisible({
		timeout: 15_000,
	});
	// The terminal comes back with its earlier output above it, and new input
	// must still echo (SPEC.md §9.1, §9.7).
	await expect(visiblePane(page).locator(".xterm-screen")).toBeVisible();
	await typeAndExpectEcho(page, rowsOf(page, terminalId), "after-reload");
});

test("an ended terminal offers a new one in its place", async ({ page, context }) => {
	const student = await createStudent(context);
	const terminalId = await openWithTerminal(page, student.workspaceId);

	// The pane has to reach the saved layout first, or the reload has no leaf
	// to show the ended terminal in (SPEC.md §7.5, §9.7).
	const [projectId] = await projectIds(student.workspaceId);
	if (!projectId) throw new Error("the project row was not created");
	await waitForSavedLeaf(projectId, terminalId);

	// What stopping the workspace does to the terminal rows.
	await endTerminal(terminalId);
	await page.reload();

	await expect(
		page.getByRole("tab", { name: "Terminal 1 (session ended)" }),
	).toBeVisible({ timeout: 15_000 });
	await expect(
		page.getByText("This terminal ended when the workspace stopped"),
	).toBeVisible();

	await page.getByTestId("new-terminal-here").click();

	// The new terminal takes the ended one's pane, so there is still one tab
	// even though the listing now holds two rows (SPEC.md §9.7).
	await expect(tabs(page).getByRole("tab")).toHaveCount(1);
	await expect(visiblePane(page).locator(".xterm-screen")).toBeVisible();
	const ids = await terminalIds(student.workspaceId);
	expect(ids).toHaveLength(2);
});

test("a workspace is held to eight terminals", async ({ page, context }) => {
	const student = await createStudent(context);
	await openWithTerminal(page, student.workspaceId);

	for (let index = 2; index <= 8; index += 1) {
		await newTerminal(page);
		await expect(page.getByRole("tab", { name: `Terminal ${index}` })).toBeVisible();
	}

	await newTerminal(page);

	await expect(page.getByRole("alert")).toContainText("Terminals are unavailable");
	await expect(tabs(page).getByRole("tab")).toHaveCount(8);
	expect(await terminalIds(student.workspaceId)).toHaveLength(8);
});

test("ending the session sends the user back to sign in", async ({ page, context }) => {
	const student = await createStudent(context);
	await openWithTerminal(page, student.workspaceId);

	await deleteSessions(student.userId);

	await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible({
		timeout: 20_000,
	});
	await expect(tabs(page)).toHaveCount(0);
});

test("another student's workspace shows no terminals", async ({ page, browser }) => {
	const owner = await browser.newContext({ baseURL: WEB_ORIGIN });
	const student = await createStudent(owner);
	await owner.close();

	// The signed-in user of `page` is a different student.
	await createStudent(page.context());

	await page.goto(workspacePath(student.workspaceId));

	// The shell has nothing to show, because every route for that workspace
	// answers 404 to this student (SPEC.md §24.3).
	await expect(tabs(page).getByRole("tab")).toHaveCount(0);

	const response = await page.request.get(
		`/workspaces/${student.workspaceId}/terminals`,
	);
	expect(response.status()).toBe(404);
});

test("two windows of the same student share one terminal", async ({
	browser,
	context,
}) => {
	const student = await createStudent(context);
	const first = await context.newPage();
	const terminalId = await openWithTerminal(first, student.workspaceId);

	const second = await browser.newContext({ baseURL: WEB_ORIGIN });
	await second.addCookies([
		{ name: "portikus_session", value: student.sessionToken, url: WEB_ORIGIN },
	]);
	const secondPage = await second.newPage();
	try {
		const [projectId] = await projectIds(student.workspaceId);
		await secondPage.goto(workspacePath(student.workspaceId, projectId));
		await expect(secondPage.getByRole("tab", { name: "Terminal 1" })).toBeVisible({
			timeout: 15_000,
		});
		await expect(visiblePane(secondPage).locator(".xterm-screen")).toBeVisible();
		await expectConnected(secondPage, terminalId);

		// The agent broadcasts to every attachment of the terminal, so what is
		// typed in one window shows up in the other.
		await typeAndExpectEcho(first, rowsOf(first, terminalId), "shared-line");
		await expect(rowsOf(secondPage, terminalId)).toContainText("shared-line", {
			timeout: 15_000,
		});
	} finally {
		await second.close();
	}
});

/**
 * Click a run of text inside a terminal. xterm draws its rows as DOM text,
 * so a Range over the characters gives their exact position, and the link
 * has to be hovered before the click for xterm to treat it as a link.
 */
async function clickTerminalText(page: Page, text: string): Promise<void> {
	const box = await page.evaluate((needle) => {
		const rows = document.querySelector(".pk-termgroup:not([hidden]) .xterm-rows");
		if (!rows) return null;
		const walker = document.createTreeWalker(rows, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			const index = (node.textContent ?? "").indexOf(needle);
			if (index >= 0) {
				const range = document.createRange();
				range.setStart(node, index);
				range.setEnd(node, index + needle.length);
				const rect = range.getBoundingClientRect();
				return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
			}
			node = walker.nextNode();
		}
		return null;
	}, text);
	if (!box) throw new Error(`"${text}" is not on screen in the terminal`);
	await page.mouse.move(box.x, box.y);
	await page.mouse.move(box.x, box.y);
	await page.mouse.click(box.x, box.y);
}

test("a file reference in the output opens the file route", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const terminalId = await openWithTerminal(page, student.workspaceId);

	await typeAndExpectEcho(page, rowsOf(page, terminalId), "src/auth.ts:73");

	await clickTerminalText(page, "src/auth.ts:73");

	const [fileProject] = await projectIds(student.workspaceId);
	await expect(page).toHaveURL(
		`/workspaces/${student.workspaceId}/projects/${fileProject}/files?path=src%2Fauth.ts&line=73`,
	);
	await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
});

test("a localhost URL in the output opens the preview route", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const terminalId = await openWithTerminal(page, student.workspaceId);

	await typeAndExpectEcho(page, rowsOf(page, terminalId), "http://localhost:3000/x");

	await clickTerminalText(page, "http://localhost:3000/x");

	const [previewProject] = await projectIds(student.workspaceId);
	await expect(page).toHaveURL(
		`/workspaces/${student.workspaceId}/projects/${previewProject}/preview/3000`,
	);
	await expect(page.getByRole("heading", { name: "Preview" })).toBeVisible();
});

test("the title bar follows cd", async ({ page, context }) => {
	const student = await createStudent(context);
	const terminalId = await openWithTerminal(page, student.workspaceId);

	const title = visiblePane(page).locator(".pk-term-bar-title");
	await expect(title).toHaveText("Terminal 1 · ~/projects/terminal-work");

	// The fake agent answers a `cd` with the cwd frame the real agent sends
	// after it polls tmux (SPEC.md §9.3).
	await typeAndExpectEcho(page, rowsOf(page, terminalId), "cd /tmp");
	await expect(title).toHaveText("Terminal 1 · /tmp");
});

/** The fake agent, which the end-to-end run puts on this port. */
const FAKE_AGENT_URL = `http://127.0.0.1:${process.env.FAKE_AGENT_PORT ?? "7400"}`;

/** Put lines on a terminal's screen without typing for them. */
async function printLines(terminalId: string, lines: string[]): Promise<void> {
	const response = await fetch(
		`${FAKE_AGENT_URL}/__test/terminals/${terminalId}/output`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ lines }),
		},
	);
	if (!response.ok) throw new Error(`could not print lines: ${response.status}`);
}

/** Numbered so that no line's text is contained in another line's. */
function manyLines(count: number): string[] {
	return Array.from(
		{ length: count },
		(_, i) => `SCROLL-${String(i + 1).padStart(4, "0")}`,
	);
}

/** How many browsers the agent has attached to a terminal. */
async function attachmentsOf(terminalId: string): Promise<number> {
	const response = await fetch(
		`${FAKE_AGENT_URL}/__test/terminals/${terminalId}/attachments`,
	);
	const body = (await response.json()) as { attachments: number };
	return body.attachments;
}

/**
 * Print lines and wait for them. The agent only sends output to the
 * attachments it has, and the browser's attachment lands a moment after the
 * page says it is connected, so wait for the agent to have it first.
 */
async function printUntilVisible(
	page: Page,
	terminalId: string,
	lines: string[],
): Promise<void> {
	await expect.poll(() => attachmentsOf(terminalId)).toBeGreaterThan(0);
	await printLines(terminalId, lines);
	await expect(rowsOf(page, terminalId)).toContainText(lines[lines.length - 1] ?? "");
}

/**
 * Turn the wheel over the terminal. One wheel event moves it a few lines
 * however large the delta is, the way one notch of a real wheel does, so
 * going a long way back takes many of them.
 */
async function wheelOverTerminal(page: Page, notches: number): Promise<void> {
	await visiblePane(page).locator(".xterm-screen").hover();
	const delta = notches < 0 ? -300 : 300;
	for (let i = 0; i < Math.abs(notches); i += 1) {
		await page.mouse.wheel(0, delta);
	}
}

test("the wheel scrolls back through earlier output", async ({ page, context }) => {
	const student = await createStudent(context);
	const terminalId = await openWithTerminal(page, student.workspaceId);
	const rows = rowsOf(page, terminalId);

	await printUntilVisible(page, terminalId, manyLines(200));
	// The screen is far shorter than 200 lines, so the first ones are above it.
	await expect(rows).not.toContainText("SCROLL-0001");

	// Wheel up, the conventional direction for older output.
	await wheelOverTerminal(page, -80);
	await expect(rows).toContainText("SCROLL-0001");
	await expect(rows).not.toContainText("SCROLL-0200");

	// And back down to where the prompt is.
	await wheelOverTerminal(page, 80);
	await expect(rows).toContainText("SCROLL-0200");
	await expect(rows).not.toContainText("SCROLL-0001");
});

test("a reload shows earlier output above the prompt", async ({ page, context }) => {
	const student = await createStudent(context);
	const terminalId = await openWithTerminal(page, student.workspaceId);

	await printUntilVisible(page, terminalId, manyLines(60));

	await page.reload();
	await expect(page.getByRole("tab", { name: "Terminal 1" })).toBeVisible({
		timeout: 15_000,
	});
	await expectConnected(page, terminalId);

	// The agent sends what scrolled off before the shell's screen is drawn, so
	// there is earlier output to scroll back to (SPEC.md §9.1).
	await wheelOverTerminal(page, -40);
	await expect(rowsOf(page, terminalId)).toContainText("SCROLL-0001");
});

/** Everything the fake agent has been sent on any attachment. */
async function framesSentToAgent(terminalId: string): Promise<string[]> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/received`);
	const body = (await response.json()) as {
		received: { terminalId: string; text: string }[];
	};
	// One fake agent serves every workspace in the run, so take this
	// terminal's frames only.
	return body.received
		.filter((frame) => frame.terminalId === terminalId)
		.map((frame) => frame.text);
}

/** The escape a terminal sends for the down and up arrow keys. */
const ARROW_KEY = /\\u001b\[[AB]|\\u001bO[AB]/;

/** Say a full-screen program has taken the terminal, or given it back. */
async function setAlternateScreen(
	terminalId: string,
	alternate: boolean,
): Promise<void> {
	const response = await fetch(
		`${FAKE_AGENT_URL}/__test/terminals/${terminalId}/screen`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ alternate }),
		},
	);
	if (!response.ok) throw new Error(`could not set the screen: ${response.status}`);
}

/**
 * While a full-screen program such as nano or less holds the terminal there
 * is nothing of its own to scroll, so wheel notches become arrow keys and
 * move it a line at a time. At a shell prompt the wheel scrolls the
 * terminal's own output instead (SPEC.md §9.1).
 */
test("the wheel moves a full-screen program a line at a time", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const terminalId = await openWithTerminal(page, student.workspaceId);
	const rows = rowsOf(page, terminalId);

	await printUntilVisible(page, terminalId, manyLines(200));

	await setAlternateScreen(terminalId, true);
	const before = (await framesSentToAgent(terminalId)).length;
	await wheelOverTerminal(page, -1);
	await expect
		.poll(async () => (await framesSentToAgent(terminalId)).slice(before).join(""))
		.toMatch(ARROW_KEY);
	// The program owns the screen, so nothing of the terminal's scrolled.
	await expect(rows).toContainText("SCROLL-0200");

	// Giving the screen back puts the wheel on the terminal's own output.
	await setAlternateScreen(terminalId, false);
	const afterLeaving = (await framesSentToAgent(terminalId)).length;
	await wheelOverTerminal(page, -80);
	await expect(rows).toContainText("SCROLL-0001");
	expect(
		(await framesSentToAgent(terminalId)).slice(afterLeaving).join(""),
	).not.toMatch(ARROW_KEY);
});

/**
 * xterm.js 6 draws its own scrollbar rather than letting the browser do it,
 * so the thin quiet bar of the design system is set through xterm's options
 * and has to be checked on the element it actually draws (SPEC.md §9.1).
 */
test("the terminal's scrollbar is thin, rounded and has no track", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const terminalId = await openWithTerminal(page, student.workspaceId);

	await printUntilVisible(page, terminalId, manyLines(200));
	await wheelOverTerminal(page, -20);

	const measured = await page.evaluate(() => {
		const bar = document.querySelector(
			".pk-terminal-surface .xterm-scrollable-element > .scrollbar.vertical",
		);
		const slider = bar?.querySelector(".slider");
		if (!(bar instanceof HTMLElement) || !(slider instanceof HTMLElement)) return null;
		return {
			barWidth: bar.getBoundingClientRect().width,
			track: getComputedStyle(bar).backgroundColor,
			sliderWidth: slider.getBoundingClientRect().width,
			sliderBackground: getComputedStyle(slider).backgroundColor,
			sliderRadius: getComputedStyle(slider).borderRadius,
		};
	});

	expect(measured).toEqual({
		barWidth: 6,
		track: "rgba(0, 0, 0, 0)",
		sliderWidth: 6,
		sliderBackground: "rgba(154, 147, 134, 0.4)",
		sliderRadius: "9999px",
	});
});

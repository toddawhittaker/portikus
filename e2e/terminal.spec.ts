import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createStudent,
	deleteSessions,
	endTerminal,
	query,
	terminalIds,
	WEB_ORIGIN,
} from "./helpers";

/**
 * The workspace terminal screen (SPEC.md §6.7, §6.8, §9, §14.9). The fake
 * workspace agent echoes every frame it is sent back as output, prefixed
 * with "echo:", so anything typed shows up in the terminal.
 */

/** The tab strip and the pane of the terminal that is currently shown. */
function tabs(page: Page): Locator {
	return page.getByRole("tablist", { name: "Terminals" });
}

function visiblePane(page: Page): Locator {
	return page.locator(".pk-terminal-pane:not([hidden])");
}

function rowsOf(page: Page, terminalId: string): Locator {
	return page.locator(`[data-testid=terminal-pane-${terminalId}] .xterm-rows`);
}

async function newTerminal(page: Page): Promise<void> {
	await page.getByRole("button", { name: "New terminal", exact: true }).click();
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

/** Open the workspace screen with one terminal ready, and return its id. */
async function openWithTerminal(page: Page, workspaceId: string): Promise<string> {
	await page.goto(`/workspaces/${workspaceId}`);
	await expect(tabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await expect(page.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
	const [id] = await terminalIds(workspaceId);
	if (!id) throw new Error("the terminal row was not created");
	await expect(visiblePane(page).locator(".xterm-screen")).toBeVisible();
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

	// Double-clicking a tab renames it.
	await page.getByRole("tab", { name: "Terminal 2" }).dblclick();
	const input = page.getByLabel("Rename Terminal 2");
	await input.fill("Build");
	await input.press("Enter");
	await expect(page.getByRole("tab", { name: "Build" })).toBeVisible();

	// Closing a terminal ends it. The tab stays, marked ended, so the user can
	// start a new one in its place (SPEC.md §6.8, §9.7).
	await page.getByRole("button", { name: "Close Build" }).click();
	await expect(page.getByRole("tab", { name: "Build (ended)" })).toBeVisible();
	expect(
		await query<{ count: string }>(
			"select count(*)::text as count from terminals where workspace_id = $1 and ended_at is null",
			[student.workspaceId],
		),
	).toEqual([{ count: "2" }]);
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
	// Scrollback is not replayed (SPEC.md §9.7); new input must still echo.
	await expect(visiblePane(page).locator(".xterm-screen")).toBeVisible();
	await typeAndExpectEcho(page, rowsOf(page, terminalId), "after-reload");
});

test("an ended terminal offers a new one in its place", async ({ page, context }) => {
	const student = await createStudent(context);
	const terminalId = await openWithTerminal(page, student.workspaceId);

	// What stopping the workspace does to the terminal rows.
	await endTerminal(terminalId);
	await page.reload();

	await expect(page.getByRole("tab", { name: "Terminal 1 (ended)" })).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByText("This terminal has ended.")).toBeVisible();

	await page.getByRole("button", { name: "New terminal like Terminal 1" }).click();

	await expect(tabs(page).getByRole("tab")).toHaveCount(2);
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

	await page.goto(`/workspaces/${student.workspaceId}`);

	await expect(page.getByRole("alert")).toContainText("Terminals are unavailable", {
		timeout: 15_000,
	});
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
		await secondPage.goto(`/workspaces/${student.workspaceId}`);
		await expect(secondPage.getByRole("tab", { name: "Terminal 1" })).toBeVisible({
			timeout: 15_000,
		});
		await expect(visiblePane(secondPage).locator(".xterm-screen")).toBeVisible();

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
		const rows = document.querySelector(".pk-terminal-pane:not([hidden]) .xterm-rows");
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

	await expect(page).toHaveURL(
		`/workspaces/${student.workspaceId}/files?path=src%2Fauth.ts&line=73`,
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

	await expect(page).toHaveURL(`/workspaces/${student.workspaceId}/preview/3000`);
	await expect(page.getByRole("heading", { name: "Preview" })).toBeVisible();
});

import { type Browser, expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	newTerminal,
	type TestStudent,
	terminalIds,
	WEB_ORIGIN,
	workspacePath,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * One terminal shown in two browsers has one size, and it is the size of the
 * browser the student is using. A browser where the terminal is hidden, or
 * whose pane has no box yet, never sends a size (SPEC.md §9.7).
 */

interface SentSize {
	terminalId: string;
	cols: number;
	rows: number;
}

/** Every resize frame `page` sends, by terminal. */
function recordSizes(page: Page): SentSize[] {
	const sizes: SentSize[] = [];
	page.on("websocket", (socket) => {
		const terminalId = /\/terminals\/([^/]+)\/ws/.exec(socket.url())?.[1];
		if (!terminalId) return;
		socket.on("framesent", ({ payload }) => {
			if (typeof payload !== "string" || !payload.includes('"resize"')) return;
			const frame = JSON.parse(payload) as { cols: number; rows: number };
			sizes.push({ terminalId, cols: frame.cols, rows: frame.rows });
		});
	});
	return sizes;
}

async function secondBrowser(browser: Browser, student: TestStudent) {
	const context = await browser.newContext({
		baseURL: WEB_ORIGIN,
		viewport: { width: 1000, height: 600 },
	});
	await context.addCookies([
		{ name: "portikus_session", value: student.sessionToken, url: WEB_ORIGIN },
	]);
	return context;
}

/** Rows xterm.js draws in the pane, which is the size it would send. */
async function rowsOnScreen(page: Page, terminalId: string): Promise<number> {
	return page
		.locator(`[data-testid=terminal-pane-${terminalId}] .xterm-rows > div`)
		.count();
}

async function open(page: Page, workspaceId: string, projectId: string) {
	await page.goto(workspacePath(workspaceId, projectId));
	await expect(page.getByTestId("work-tabs")).toBeVisible({ timeout: 15_000 });
}

/** Earlier output, so a new attachment's first frame arrives at once. */
async function printLines(terminalId: string, lines: string[]) {
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

async function projectWithTerminals(page: Page, workspaceId: string, count: number) {
	const project = await createProject(workspaceId, { name: "Two Browsers" });
	await open(page, workspaceId, project.id);
	for (let made = 1; made <= count; made++) {
		await newTerminal(page);
		await expect
			.poll(async () => (await terminalIds(workspaceId, project.id)).length)
			.toBe(made);
	}
	const ids = await terminalIds(workspaceId, project.id);
	for (const id of ids) await expectConnected(page, id);
	return { projectId: project.id, ids };
}

test("the browser in use sends its own size, and typing in the other takes it back", async ({
	browser,
	context,
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 900 });
	const sizes = recordSizes(page);
	const student = await createStudent(context);
	const { projectId, ids } = await projectWithTerminals(page, student.workspaceId, 1);
	const terminalId = ids[0] as string;
	const second = await secondBrowser(browser, student);
	try {
		const other = await second.newPage();
		const otherSizes = recordSizes(other);
		await open(other, student.workspaceId, projectId);
		await expectConnected(other, terminalId);

		// Using A: its size goes to the terminal, and it is A's.
		const sentByA = sizes.length;
		await page
			.getByTestId(`terminal-pane-${terminalId}`)
			.locator(".xterm-screen")
			.click();
		await expect.poll(() => sizes.length).toBeGreaterThan(sentByA);
		expect(sizes.at(-1)?.rows).toBe(await rowsOnScreen(page, terminalId));

		// Typing in B: B says its size first, and it is B's.
		const sentByB = otherSizes.length;
		await other
			.getByTestId(`terminal-pane-${terminalId}`)
			.locator(".xterm-screen")
			.click();
		await other.keyboard.insertText("ls");
		await expect.poll(() => otherSizes.length).toBeGreaterThan(sentByB);
		const bRows = await rowsOnScreen(other, terminalId);
		expect(otherSizes.at(-1)?.rows).toBe(bRows);
		expect(bRows).not.toBe(await rowsOnScreen(page, terminalId));
	} finally {
		await second.close();
	}
});

test("a terminal in a hidden tab never sends a size", async ({
	browser,
	context,
	page,
}) => {
	const student = await createStudent(context);
	const { projectId, ids } = await projectWithTerminals(page, student.workspaceId, 2);
	const [first, hidden] = ids as [string, string];
	await printLines(hidden, ["earlier output"]);

	const second = await secondBrowser(browser, student);
	try {
		const other = await second.newPage();
		const sizes = recordSizes(other);
		await open(other, student.workspaceId, projectId);
		// B shows the first terminal; the second sits in a tab behind it.
		await other.getByRole("tab", { name: "Terminal 1" }).click();
		await expectConnected(other, first);
		await expectConnected(other, hidden);
		await expect(other.getByTestId(`terminal-pane-${hidden}`)).toBeHidden();

		// A layout change in B while the tab is hidden still sends nothing for it.
		await other.setViewportSize({ width: 800, height: 500 });
		await other.waitForTimeout(500);
		expect(sizes.filter((size) => size.terminalId === hidden)).toEqual([]);

		// Showing it is using it: now it says its size.
		await other.getByRole("tab", { name: "Terminal 2" }).click();
		await expect
			.poll(() => sizes.filter((size) => size.terminalId === hidden).length)
			.toBeGreaterThan(0);
		const shown = sizes.filter((size) => size.terminalId === hidden).at(-1);
		expect(shown?.rows).toBe(await rowsOnScreen(other, hidden));
	} finally {
		await second.close();
	}
});

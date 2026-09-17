import { expect, type Locator, type Page, test } from "@playwright/test";
import { createProject, createStudent, terminalIds, workspacePath } from "./helpers";

/**
 * Terminal copy and paste (SPEC.md §9, plan decisions "Clipboard in the
 * terminal"). Chromium only: it is the one browser Playwright can grant
 * clipboard permissions to. The orchestrator removes the guard below once
 * the Epic 6 work area lands.
 */
test.describe("terminal clipboard", () => {
	test.use({ permissions: ["clipboard-read", "clipboard-write"] });

	function rowsOf(page: Page, terminalId: string): Locator {
		return page.locator(`[data-testid=terminal-pane-${terminalId}] .xterm-rows`);
	}

	async function readClipboard(page: Page): Promise<string> {
		return page.evaluate(() => navigator.clipboard.readText());
	}

	async function writeClipboard(page: Page, text: string): Promise<void> {
		await page.evaluate((value) => navigator.clipboard.writeText(value), text);
	}

	/** Where a run of text sits on screen, so the mouse can act on it. */
	async function boxOf(
		page: Page,
		terminalId: string,
		text: string,
	): Promise<{ x1: number; x2: number; y: number }> {
		const box = await page.evaluate(
			([id, needle]) => {
				const rows = document.querySelector(
					`[data-testid=terminal-pane-${id}] .xterm-rows`,
				);
				if (!rows) return null;
				const walker = document.createTreeWalker(rows, NodeFilter.SHOW_TEXT);
				let node = walker.nextNode();
				while (node) {
					const index = (node.textContent ?? "").indexOf(needle as string);
					if (index >= 0) {
						const range = document.createRange();
						range.setStart(node, index);
						range.setEnd(node, index + (needle as string).length);
						const rect = range.getBoundingClientRect();
						return {
							x1: rect.x + 1,
							x2: rect.x + rect.width - 1,
							y: rect.y + rect.height / 2,
						};
					}
					node = walker.nextNode();
				}
				return null;
			},
			[terminalId, text] as const,
		);
		if (!box) throw new Error(`"${text}" is not on screen in the terminal`);
		return box;
	}

	/** Drag the mouse across a run of text, the way a student selects it. */
	async function selectText(
		page: Page,
		terminalId: string,
		text: string,
	): Promise<void> {
		const box = await boxOf(page, terminalId, text);
		await page.mouse.move(box.x1, box.y);
		await page.mouse.down();
		await page.mouse.move(box.x2, box.y, { steps: 8 });
		await page.mouse.up();
	}

	async function typeAndExpectEcho(
		page: Page,
		terminalId: string,
		text: string,
	): Promise<void> {
		const rows = rowsOf(page, terminalId);
		await expect
			.poll(
				async () => {
					const seen = (await rows.textContent()) ?? "";
					if (seen.includes(text)) return seen;
					await page
						.locator(`[data-testid=terminal-pane-${terminalId}] .xterm-screen`)
						.click();
					await page.keyboard.insertText(text);
					await page.keyboard.press("Enter");
					await page.waitForTimeout(500);
					return (await rows.textContent()) ?? "";
				},
				{ timeout: 20_000, intervals: [200, 500, 1000, 2000] },
			)
			.toContain(text);
	}

	/** A project, a terminal, and one known line of output to select. */
	async function openWithOutput(
		page: Page,
		workspaceId: string,
		marker: string,
	): Promise<string> {
		const project = await createProject(workspaceId, { name: "Clipboard" });
		await page.goto(workspacePath(workspaceId, project.id));
		await expect(page.getByTestId("work-tabs")).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("launcher").click();
		await page.getByRole("menuitem", { name: "Terminal", exact: true }).click();
		await expect
			.poll(async () => (await terminalIds(workspaceId, project.id)).length)
			.toBe(1);
		const [terminalId] = await terminalIds(workspaceId, project.id);
		if (!terminalId) throw new Error("the terminal row was not created");
		await expect(
			page.locator(`[data-testid=terminal-pane-${terminalId}]`),
		).toHaveAttribute("data-connected", "true", { timeout: 15_000 });
		await typeAndExpectEcho(page, terminalId, marker);
		return terminalId;
	}

	test("selecting output copies it at once", async ({ page, context }) => {
		const student = await createStudent(context);
		const terminalId = await openWithOutput(page, student.workspaceId, "copyme");

		await selectText(page, terminalId, "copyme");

		await expect.poll(() => readClipboard(page)).toContain("copyme");
	});

	test("right-clicking a selection copies it and clears the selection", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const terminalId = await openWithOutput(page, student.workspaceId, "rightcopy");
		await writeClipboard(page, "stale");

		await selectText(page, terminalId, "rightcopy");
		const box = await boxOf(page, terminalId, "rightcopy");
		await page.mouse.click(box.x1 + 1, box.y, { button: "right" });

		await expect.poll(() => readClipboard(page)).toContain("rightcopy");
		// The browser menu is suppressed and the selection is let go.
		await expect
			.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ""))
			.toBe("");
	});

	test("right-clicking with nothing selected pastes into the shell", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const terminalId = await openWithOutput(page, student.workspaceId, "ready");
		await writeClipboard(page, "pasted-by-right-click");

		const box = await boxOf(page, terminalId, "ready");
		await page.mouse.click(box.x1, box.y + 40, { button: "right" });

		await expect(rowsOf(page, terminalId)).toContainText("pasted-by-right-click", {
			timeout: 15_000,
		});
	});

	test("Ctrl+Shift+C copies and Ctrl+Shift+V pastes", async ({ page, context }) => {
		const student = await createStudent(context);
		const terminalId = await openWithOutput(page, student.workspaceId, "shifted");

		await selectText(page, terminalId, "shifted");
		await writeClipboard(page, "stale");
		await page.keyboard.press("Control+Shift+KeyC");
		await expect.poll(() => readClipboard(page)).toContain("shifted");

		await writeClipboard(page, "pasted-with-shift");
		await page.keyboard.press("Control+Shift+KeyV");
		await expect(rowsOf(page, terminalId)).toContainText("pasted-with-shift", {
			timeout: 15_000,
		});
	});

	test("Ctrl+V pastes", async ({ page, context }) => {
		const student = await createStudent(context);
		const terminalId = await openWithOutput(page, student.workspaceId, "plainv");
		await writeClipboard(page, "pasted-with-ctrl-v");

		await page
			.locator(`[data-testid=terminal-pane-${terminalId}] .xterm-screen`)
			.click();
		await page.keyboard.press("Control+KeyV");

		await expect(rowsOf(page, terminalId)).toContainText("pasted-with-ctrl-v", {
			timeout: 15_000,
		});
	});

	test("Ctrl+C with a selection copies it", async ({ page, context }) => {
		const student = await createStudent(context);
		const terminalId = await openWithOutput(page, student.workspaceId, "ctrlccopy");
		await writeClipboard(page, "stale");

		await selectText(page, terminalId, "ctrlccopy");
		await page.keyboard.press("Control+KeyC");

		await expect.poll(() => readClipboard(page)).toContain("ctrlccopy");
		// Copying must not also send the interrupt.
		await expect(rowsOf(page, terminalId)).not.toContainText("^C");
	});

	test("Ctrl+C without a selection reaches the shell as the interrupt", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const terminalId = await openWithOutput(page, student.workspaceId, "sleep 30");

		await page
			.locator(`[data-testid=terminal-pane-${terminalId}] .xterm-screen`)
			.click();
		await page.keyboard.press("Control+KeyC");

		// The fake agent answers the interrupt byte with ^C, as a shell does.
		await expect(rowsOf(page, terminalId)).toContainText("^C", { timeout: 15_000 });
	});
});

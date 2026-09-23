import { expect, type Locator, type Page, test } from "@playwright/test";
import { createProject, createStudent, terminalIds, workspacePath } from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

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

	/** How many times a marker shows in the terminal's rows. */
	async function countIn(
		page: Page,
		terminalId: string,
		text: string,
	): Promise<number> {
		const seen = (await rowsOf(page, terminalId).textContent()) ?? "";
		return seen.split(text).length - 1;
	}

	/**
	 * A paste must land exactly once. Ctrl+V used to reach the shell twice,
	 * once from our clipboard read and once from the browser's own paste
	 * event, which a "contains" assertion cannot tell apart.
	 */
	async function expectPastedOnce(
		page: Page,
		terminalId: string,
		text: string,
	): Promise<void> {
		await expect(rowsOf(page, terminalId)).toContainText(text, { timeout: 15_000 });
		// Give a second paste time to arrive before ruling it out.
		await page.waitForTimeout(1500);
		expect(await countIn(page, terminalId, text)).toBe(1);
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
		await expectPastedOnce(page, terminalId, "pasted-with-shift");
	});

	test("Ctrl+V pastes", async ({ page, context }) => {
		const student = await createStudent(context);
		const terminalId = await openWithOutput(page, student.workspaceId, "plainv");
		await writeClipboard(page, "pasted-with-ctrl-v");

		await page
			.locator(`[data-testid=terminal-pane-${terminalId}] .xterm-screen`)
			.click();
		await page.keyboard.press("Control+KeyV");

		await expectPastedOnce(page, terminalId, "pasted-with-ctrl-v");
	});

	/**
	 * Pastejacking (SPEC.md §24): text a web page planted on the clipboard
	 * must not be able to end the paste bracket early. The fake agent echoes
	 * the input message as JSON, where a surviving escape would show as \u001b.
	 */
	for (const how of ["Ctrl+V", "right-click"] as const) {
		test(`a planted end-of-paste marker is removed on ${how}`, async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const terminalId = await openWithOutput(page, student.workspaceId, "hostile");
			await writeClipboard(page, "planted\u001b[201~echo-pwned");

			if (how === "Ctrl+V") {
				await page
					.locator(`[data-testid=terminal-pane-${terminalId}] .xterm-screen`)
					.click();
				await page.keyboard.press("Control+KeyV");
			} else {
				const box = await boxOf(page, terminalId, "hostile");
				await page.mouse.click(box.x1, box.y + 40, { button: "right" });
			}

			await expectPastedOnce(page, terminalId, "planted[201~echo-pwned");
			await expect(rowsOf(page, terminalId)).not.toContainText("\\u001b");
		});
	}

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

	/** The fake agent, which the end-to-end run puts on this port. */

	/** How many browsers the agent has attached to a terminal. */
	async function attachmentsOf(terminalId: string): Promise<number> {
		const response = await fetch(
			`${FAKE_AGENT_URL}/__test/terminals/${terminalId}/attachments`,
		);
		const body = (await response.json()) as { attachments: number };
		return body.attachments;
	}

	/** Put bytes on a terminal's screen without typing for them. */
	async function printLine(terminalId: string, line: string): Promise<void> {
		await expect.poll(() => attachmentsOf(terminalId)).toBeGreaterThan(0);
		const response = await fetch(
			`${FAKE_AGENT_URL}/__test/terminals/${terminalId}/output`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ lines: [line] }),
			},
		);
		if (!response.ok) throw new Error(`could not print: ${response.status}`);
	}

	test("a program copying with OSC 52 reaches the system clipboard", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const terminalId = await openWithOutput(page, student.workspaceId, "osc52");
		await writeClipboard(page, "stale");

		// This is how a coding agent's "press c to copy the login URL" works: the
		// program writes OSC 52, tmux passes it on, and the browser copies it
		// (SPEC.md §9, §10).
		const url = "https://accounts.example.com/device?code=OSC52CODE";
		const encoded = Buffer.from(url, "utf8").toString("base64");
		const esc = String.fromCharCode(27);
		const bell = String.fromCharCode(7);
		// Only the pane the student is working in may copy (SPEC.md §24.2).
		await page
			.locator(`[data-testid=terminal-pane-${terminalId}] .xterm-screen`)
			.click();
		await printLine(terminalId, `${esc}]52;c;${encoded}${bell}`);

		await expect.poll(() => readClipboard(page), { timeout: 15_000 }).toBe(url);
		// And the student is told the clipboard changed under them.
		await expect(
			page.getByText(/Copied to your clipboard by a program in/).first(),
		).toBeVisible({ timeout: 15_000 });
	});
});

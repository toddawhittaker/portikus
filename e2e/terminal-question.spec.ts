/**
 * Claude Code's question in a terminal tab, as the chat's question card over
 * the bottom of the pane (SPEC.md §10.8): the owner answers it in the browser
 * or hands it back to the terminal, and the keyboard returns to the terminal
 * when the card goes (SPEC.md §25.8). The fake agent stands in for the hook:
 * each post replaces the whole list of agent states.
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	expectNoViolations,
	newTerminal,
	openFileTab,
	routeApi,
	terminalIds,
	toast,
	workspacePath,
	workTabs,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

const QUESTION = {
	id: "toolu_e2e_question",
	questions: [
		{
			question: "Which database should the API use?",
			header: "Database",
			multiSelect: false,
			options: [
				{ label: "PostgreSQL", description: "A server, like production" },
				{ label: "SQLite", description: "One file, nothing to run" },
			],
		},
	],
};

/** Put the question on the terminal's entry, or take it off. */
async function setQuestion(
	workspaceId: string,
	terminalId: string,
	question: typeof QUESTION | null,
): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/coding-agents`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			key: workspaceId,
			terminals: [
				{
					terminalId,
					agent: "claude",
					state: "needs-input",
					...(question ? { question } : {}),
				},
			],
		}),
	});
	if (!response.ok) throw new Error(`the fake agent refused: ${response.status}`);
}

/** The answers the fake agent was forwarded for a workspace, oldest first. */
async function forwarded(workspaceId: string): Promise<unknown[]> {
	const response = await fetch(
		`${FAKE_AGENT_URL}/__test/terminal-questions?key=${workspaceId}`,
	);
	return ((await response.json()) as { answers: unknown[] }).answers;
}

/** Hold back the agent's state frames, as a hook that has not reported yet. */
async function holdStates(workspaceId: string, hold: boolean): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/coding-agents-hold`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, hold }),
	});
	if (!response.ok) throw new Error(`the fake agent refused: ${response.status}`);
}

/** A student with one terminal open and connected. */
async function openTerminal(page: Page, context: Parameters<typeof createStudent>[0]) {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Questions" });
	const path = workspacePath(student.workspaceId, project.id);
	await page.goto(path);
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-terminal").click();
	// The row is written after the click returns, so wait for it.
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [terminalId] = await terminalIds(student.workspaceId, project.id);
	if (!terminalId) throw new Error("the terminal row was not created");
	await expectConnected(page, terminalId);
	return { workspaceId: student.workspaceId, terminalId, path };
}

const FILE = "src/app.ts";

/** A terminal and an open file side by side in one tab, so both are on screen. */
async function openTerminalBesideFile(
	page: Page,
	context: Parameters<typeof createStudent>[0],
) {
	const student = await createStudent(context);
	const project = await openFileTab(
		page,
		student,
		"Beside",
		FILE,
		"const answer = 42;\n",
	);
	const lines = page.getByTestId(`editor-${FILE}`).locator(".view-lines");
	await expect(lines).toContainText("const answer = 42;", { timeout: 60_000 });
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [terminalId] = await terminalIds(student.workspaceId, project.id);
	if (!terminalId) throw new Error("the terminal row was not created");
	await expectConnected(page, terminalId);
	// "Move into" the terminal's tab puts the file in a split beside it.
	await page.getByTestId(`tab-file:${FILE}`).click();
	await page.getByTestId(`file-frame-actions-${FILE}`).focus();
	await page.keyboard.press("Enter");
	const moveInto = page.getByRole("menuitem", { name: "Move into" });
	await expect(moveInto).toBeVisible();
	await moveInto.focus();
	await page.keyboard.press("ArrowRight");
	await page
		.getByRole("menu", { name: "Move into" })
		.getByTestId(`file-frame-move-into-${terminalId}`)
		.press("Enter");
	await expect(page.getByTestId(`file-frame-${FILE}`)).toBeVisible();
	await expect(page.getByTestId(`terminal-leaf-${terminalId}`)).toBeVisible();
	return { workspaceId: student.workspaceId, terminalId, lines };
}

const card = (page: Page) => page.getByRole("region", { name: "Claude's question" });
const shell = (page: Page, terminalId: string) =>
	page.locator(`[data-testid="terminal-pane-${terminalId}"] .xterm-helper-textarea`);

test.describe.configure({ timeout: 90_000 });

test("the card sends the answer, and clears in every tab", async ({
	page,
	context,
}) => {
	const { workspaceId, terminalId, path } = await openTerminal(page, context);
	const other = await context.newPage();
	await other.goto(path);
	await expectConnected(other, terminalId);

	await setQuestion(workspaceId, terminalId, QUESTION);
	await expect(card(page)).toBeVisible();
	await expect(card(other)).toBeVisible();
	// The student was typing in the terminal, so the card takes the keyboard.
	await expect(page.getByRole("radio", { name: "PostgreSQL" })).toBeFocused();
	await page.getByRole("radio", { name: "SQLite" }).check();
	await page.getByRole("button", { name: /Submit/ }).click();

	await expect(card(page)).toHaveCount(0);
	await expect(shell(page, terminalId)).toBeFocused();
	// The agent takes the question off once the hook has its answer.
	await expect(card(other)).toHaveCount(0);
	expect(await forwarded(workspaceId)).toEqual([
		{ id: QUESTION.id, answers: { "Which database should the API use?": "SQLite" } },
	]);
});

test("Answer in the terminal hands the question back; Escape does not", async ({
	page,
	context,
}) => {
	const { workspaceId, terminalId } = await openTerminal(page, context);
	await setQuestion(workspaceId, terminalId, QUESTION);
	await expect(page.getByRole("radio", { name: "PostgreSQL" })).toBeFocused();

	await page.keyboard.press("Escape");
	await expect(card(page)).toBeVisible();
	expect(await forwarded(workspaceId)).toEqual([]);

	await page.getByRole("button", { name: "Answer in the terminal" }).click();
	await expect(card(page)).toHaveCount(0);
	expect(await forwarded(workspaceId)).toEqual([{ id: QUESTION.id, inTerminal: true }]);
	await expect(shell(page, terminalId)).toBeFocused();
});

test("an answer that comes too late says so and clears the card", async ({
	page,
	context,
}) => {
	const { workspaceId, terminalId } = await openTerminal(page, context);
	await setQuestion(workspaceId, terminalId, QUESTION);
	await expect(card(page)).toBeVisible();
	// Claude Code stops waiting before the page hears of it.
	await holdStates(workspaceId, true);
	await setQuestion(workspaceId, terminalId, null);
	await page.getByRole("radio", { name: "PostgreSQL" }).check();
	await page.getByRole("button", { name: /Submit/ }).click();

	const gone = page.getByTestId(`terminal-question-gone-${terminalId}`);
	await expect(gone).toHaveText("Answered in the terminal or timed out");
	await expect(card(page)).toHaveCount(0);
	await expect(shell(page, terminalId)).toBeFocused();
	expect(await forwarded(workspaceId)).toEqual([]);
	await expect(gone).toHaveCount(0, { timeout: 10_000 });
});

test("an answer that cannot be sent says so and keeps the question", async ({
	page,
	context,
}) => {
	const { workspaceId, terminalId } = await openTerminal(page, context);
	// No fake for an agent that cannot be reached, so the browser's request fails here.
	let sends = 0;
	await routeApi(page, "**/workspaces/*/terminals/*/question", (route) => {
		sends += 1;
		return route.fulfill({
			status: 503,
			contentType: "application/json",
			body: JSON.stringify({
				code: "AGENT_UNAVAILABLE",
				message: "The workspace is not reachable.",
			}),
		});
	});
	await setQuestion(workspaceId, terminalId, QUESTION);
	await page.getByRole("button", { name: "Answer in the terminal" }).click();
	await expect(toast(page, "Your answer was not sent")).toBeVisible();
	await expect(card(page)).toBeVisible();
	expect(await forwarded(workspaceId)).toEqual([]);

	// A failed submit keeps the student's pick and note (WCAG 3.3.7).
	await page.getByRole("radio", { name: "SQLite" }).check();
	await page.getByRole("button", { name: /Add a note/ }).click();
	const note = card(page).getByRole("textbox", { name: /note/i });
	await note.fill("one file is enough");
	await page.getByRole("button", { name: /Submit/ }).click();
	await expect.poll(() => sends).toBe(2);
	await expect(page.getByRole("button", { name: /Submit/ })).not.toHaveAttribute(
		"aria-busy",
		"true",
	);
	await expect(page.getByRole("radio", { name: "SQLite" })).toBeChecked();
	await expect(note).toHaveValue("one file is enough");
	expect(await forwarded(workspaceId)).toEqual([]);
});

test("a question announces itself when the keyboard is in the editor beside it", async ({
	page,
	context,
}) => {
	const { workspaceId, terminalId, lines } = await openTerminalBesideFile(
		page,
		context,
	);
	await lines.click();
	const live = page.getByTestId(`terminal-question-live-${terminalId}`);
	await expect(live).toHaveAttribute("aria-live", "polite");
	await expect(live).toHaveText("");

	await setQuestion(workspaceId, terminalId, QUESTION);
	await expect(card(page)).toBeVisible();
	await expect(live).toHaveText(`Claude Code in Terminal 1 is asking a question`);
	// The card did not take the keyboard from the editor.
	await expect(page.getByRole("radio", { name: "PostgreSQL" })).not.toBeFocused();

	// Answering clears the announcement.
	await page.getByRole("button", { name: "Answer in the terminal" }).click();
	await expect(card(page)).toHaveCount(0);
	await expect(live).toHaveText("");
});

test("a question that replaces another with no gap is announced again", async ({
	page,
	context,
}) => {
	const { workspaceId, terminalId, lines } = await openTerminalBesideFile(
		page,
		context,
	);
	await lines.click();
	const live = page.getByTestId(`terminal-question-live-${terminalId}`);
	await setQuestion(workspaceId, terminalId, QUESTION);
	await expect(live).toHaveText("Claude Code in Terminal 1 is asking a question");

	// Count the spoken nodes that arrive from here on: a screen reader speaks
	// an added node, and the second question's words are the same as the first's.
	await live.evaluate((region) => {
		const spoken = { added: 0 };
		new MutationObserver((records) => {
			for (const record of records) spoken.added += record.addedNodes.length;
		}).observe(region, { childList: true, subtree: true });
		(window as unknown as { spoken: typeof spoken }).spoken = spoken;
	});
	// The fake agent replaces the whole list in one post: no empty refresh between.
	await setQuestion(workspaceId, terminalId, { ...QUESTION, id: "toolu_e2e_second" });
	await expect
		.poll(() =>
			page.evaluate(
				() => (window as unknown as { spoken: { added: number } }).spoken.added,
			),
		)
		.toBeGreaterThan(0);
	await expect(live).toHaveText("Claude Code in Terminal 1 is asking a question");
});

test("no announcement when the keyboard is already in the terminal", async ({
	page,
	context,
}) => {
	const { workspaceId, terminalId } = await openTerminalBesideFile(page, context);
	await shell(page, terminalId).focus();
	await setQuestion(workspaceId, terminalId, QUESTION);
	await expect(page.getByRole("radio", { name: "PostgreSQL" })).toBeFocused();
	await expect(page.getByTestId(`terminal-question-live-${terminalId}`)).toHaveText("");
});

test("a short pane keeps terminal lines in view above the card", async ({
	page,
	context,
}) => {
	await page.setViewportSize({ width: 900, height: 420 });
	const { workspaceId, terminalId } = await openTerminal(page, context);
	await setQuestion(workspaceId, terminalId, QUESTION);
	await expect(card(page)).toBeVisible();
	const pane = await page.getByTestId(`terminal-leaf-${terminalId}`).boundingBox();
	const overlay = await page.getByTestId("terminal-question").boundingBox();
	if (!pane || !overlay) throw new Error("nothing drawn");
	expect(overlay.height).toBeLessThanOrEqual(pane.height * 0.6 + 1);
	// The card overlays the terminal; the terminal keeps its size.
	const surface = await page
		.locator(`[data-testid="terminal-pane-${terminalId}"] .pk-terminal-surface`)
		.boundingBox();
	expect(surface?.y ?? 0).toBeLessThan(overlay.y);
	expect((surface?.y ?? 0) + (surface?.height ?? 0)).toBeGreaterThan(overlay.y);
});

for (const colorScheme of ["dark", "light"] as const) {
	test(`the card over a terminal has no axe violations (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const { workspaceId, terminalId } = await openTerminal(page, context);
		await setQuestion(workspaceId, terminalId, QUESTION);
		await expect(card(page)).toBeVisible();
		await expectNoViolations(page, '[data-testid="terminal-question"]');
	});
}

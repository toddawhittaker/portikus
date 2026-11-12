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

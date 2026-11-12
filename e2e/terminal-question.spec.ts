/**
 * Claude Code's question in a terminal tab, as the chat's question card over
 * the bottom of the pane (SPEC.md §10.8): the owner answers it in the browser
 * or hands it back to the terminal, and the keyboard returns to the terminal
 * when the card goes (SPEC.md §25.8). The fake agent stands in for the hook:
 * each post replaces the whole list of agent states.
 */
import { expect, type Page, type Request, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	expectNoViolations,
	routeApi,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

const QUESTION = {
	id: "toolu_e2e_question",
	expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
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

/** Answer the question route with `status`, keeping each body the page sent. */
async function answerWith(page: Page, status: number): Promise<unknown[]> {
	const bodies: unknown[] = [];
	await routeApi(
		page,
		"**/workspaces/*/terminals/*/question",
		(route, request: Request) => {
			bodies.push(request.postDataJSON());
			return status === 204
				? route.fulfill({ status })
				: route.fulfill({
						status,
						contentType: "application/json",
						body: JSON.stringify({
							code: "AGENT_UNAVAILABLE",
							message: "Answered in the terminal or timed out",
						}),
					});
		},
	);
	return bodies;
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
	const bodies = await answerWith(page, 204);

	await setQuestion(workspaceId, terminalId, QUESTION);
	await expect(card(page)).toBeVisible();
	await expect(card(other)).toBeVisible();
	// The student was typing in the terminal, so the card takes the keyboard.
	await expect(page.getByRole("radio", { name: "PostgreSQL" })).toBeFocused();
	await page.getByRole("radio", { name: "SQLite" }).check();
	await page.getByRole("button", { name: /Submit/ }).click();

	await expect(card(page)).toHaveCount(0);
	expect(bodies).toEqual([
		{ id: QUESTION.id, answers: { "Which database should the API use?": "SQLite" } },
	]);
	await expect(shell(page, terminalId)).toBeFocused();
	// The agent takes the question off once the hook has its answer.
	await setQuestion(workspaceId, terminalId, null);
	await expect(card(other)).toHaveCount(0);
});

test("Answer in the terminal hands the question back; Escape does not", async ({
	page,
	context,
}) => {
	const { workspaceId, terminalId } = await openTerminal(page, context);
	const bodies = await answerWith(page, 204);
	await setQuestion(workspaceId, terminalId, QUESTION);
	await expect(page.getByRole("radio", { name: "PostgreSQL" })).toBeFocused();

	await page.keyboard.press("Escape");
	await expect(card(page)).toBeVisible();
	expect(bodies).toEqual([]);

	await page.getByRole("button", { name: "Answer in the terminal" }).click();
	await expect(card(page)).toHaveCount(0);
	expect(bodies).toEqual([{ id: QUESTION.id, inTerminal: true }]);
	await expect(shell(page, terminalId)).toBeFocused();
});

test("an answer that comes too late says so and clears the card", async ({
	page,
	context,
}) => {
	const { workspaceId, terminalId } = await openTerminal(page, context);
	await answerWith(page, 409);
	await setQuestion(workspaceId, terminalId, QUESTION);
	await page.getByRole("radio", { name: "PostgreSQL" }).check();
	await page.getByRole("button", { name: /Submit/ }).click();

	const gone = page.getByTestId(`terminal-question-gone-${terminalId}`);
	await expect(gone).toHaveText("Answered in the terminal or timed out");
	await expect(card(page)).toHaveCount(0);
	await expect(shell(page, terminalId)).toBeFocused();
	await expect(gone).toHaveCount(0, { timeout: 10_000 });
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

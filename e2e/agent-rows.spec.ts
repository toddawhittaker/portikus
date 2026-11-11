import { expect, type Page, test } from "@playwright/test";
import { makeChatTab, scriptedChat } from "./chat-helpers";
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
import { FAKE_AGENT_URL } from "./ports";

/**
 * Under each project in the left pane, a row per agent tab and its subagents
 * (SPEC.md §8.2). Each row is a link to its tab; a subagent's link opens its
 * tool row in a chat, and its own conversation in a panel there. The fake agent stands in for the hooks: each post
 * replaces the whole list.
 */

interface Subagent {
	id: string;
	type: string;
	description: string;
	state: "working" | "finished";
}

interface AgentTab {
	terminalId: string;
	agent: "claude" | "codex";
	state: "working" | "needs-input" | "finished";
	since?: string;
	subagents?: Subagent[];
}

async function setAgentTabs(workspaceId: string, terminals: AgentTab[]): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/coding-agents`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, terminals }),
	});
	if (!response.ok) throw new Error(`the fake agent refused: ${response.status}`);
}

function minutesAgo(minutes: number): string {
	return new Date(Date.now() - minutes * 60_000 - 5_000).toISOString();
}

/** Start Claude Code in the project open on the page; returns its terminal id. */
async function startClaude(page: Page, workspaceId: string, projectId: string) {
	const before = await terminalIds(workspaceId, projectId);
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-claude").click();
	await expect
		.poll(async () => (await terminalIds(workspaceId, projectId)).length)
		.toBe(before.length + 1);
	const id = (await terminalIds(workspaceId, projectId)).find(
		(one) => !before.includes(one),
	);
	if (!id) throw new Error("the agent's terminal was not created");
	return id;
}

/** The URL carries no selection once the work area has acted on it. */
async function expectPlainUrl(page: Page, projectId: string) {
	await expect.poll(() => new URL(page.url()).pathname).toMatch(projectId);
	await expect.poll(() => new URL(page.url()).search).toBe("");
}

for (const colorScheme of ["light", "dark"] as const) {
	test.describe(`agent rows (${colorScheme})`, () => {
		test.describe.configure({ timeout: 90_000 });

		test.beforeEach(async ({ page }) => {
			await page.emulateMedia({ colorScheme });
		});

		test("every project lists its agent tabs, and a row selects its tab", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const alpha = await createProject(student.workspaceId, { name: "Alpha" });
			const beta = await createProject(student.workspaceId, { name: "Beta" });

			await page.goto(workspacePath(student.workspaceId, alpha.id));
			await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
			const alphaAgent = await startClaude(page, student.workspaceId, alpha.id);

			await page.goto(workspacePath(student.workspaceId, beta.id));
			await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
			const betaAgent = await startClaude(page, student.workspaceId, beta.id);
			// A shell on screen, so the agent's tab is not the selected one.
			await newTerminal(page);
			await expect
				.poll(async () => (await terminalIds(student.workspaceId, beta.id)).length)
				.toBe(2);
			const shell = (await terminalIds(student.workspaceId, beta.id)).find(
				(one) => one !== betaAgent,
			);
			if (!shell) throw new Error("no shell");
			await expectConnected(page, shell);

			// A tab gets its row only once its agent has reported.
			await expect(page.getByTestId(`project-agents-${alpha.id}`)).toHaveCount(0);
			await setAgentTabs(student.workspaceId, [
				{
					terminalId: alphaAgent,
					agent: "claude",
					state: "working",
					since: minutesAgo(4),
				},
				{
					terminalId: betaAgent,
					agent: "claude",
					state: "working",
					subagents: [
						{
							id: "toolu_explore",
							type: "Explore",
							description: "Find where the login form posts",
							state: "working",
						},
					],
				},
			]);

			// The project not open shows its agents too, with the state and time.
			const alphaRows = page.getByRole("list", { name: "Agents in Alpha" });
			const alphaRow = alphaRows.getByRole("link", { name: /Claude Code \(TUI\)/ });
			await expect(alphaRow).toContainText("Working 4m");
			// The project's own state mark stays beside its name.
			await expect(page.getByTestId(`project-agent-${alpha.id}`)).toBeVisible();

			const betaRows = page.getByRole("list", { name: "Agents in Beta" });
			const sub = betaRows.getByRole("link", {
				name: "Find where the login form posts Explore (working)",
			});
			await expect(sub).toBeVisible();
			await expectNoViolations(page, '[data-testid="project-list"]');
			await page.screenshot({
				path: `screenshots/agent-rows-desktop-${colorScheme}.png`,
			});

			// A row in the open project selects its tab.
			const claudeTab = page.getByRole("tab", { name: /^Claude Code \(TUI\)/ });
			await expect(claudeTab).toHaveAttribute("aria-selected", "false");
			await betaRows.getByRole("link", { name: /Claude Code \(TUI\)/ }).click();
			await expect(claudeTab).toHaveAttribute("aria-selected", "true");
			await expectPlainUrl(page, beta.id);

			// A row in another project opens that project at its tab.
			await alphaRow.click();
			await expectPlainUrl(page, alpha.id);
			await expect(
				page.getByRole("tab", { name: /^Claude Code \(TUI\)/ }),
			).toHaveAttribute("aria-selected", "true");

			// The disclosure folds a project's agents away, and the page remembers it.
			const toggle = page.getByRole("button", { name: "Agents in Beta" });
			await expect(toggle).toHaveAttribute("aria-expanded", "true");
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-expanded", "false");
			await expect(betaRows).toBeHidden();
			await page.getByTestId(`project-item-${beta.id}`).getByRole("link").click();
			await expect(
				page.getByRole("button", { name: "Agents in Beta" }),
			).toHaveAttribute("aria-expanded", "false");
		});

		test("a subagent's row opens the chat at its tool row, wherever it was folded", async ({
			page,
			context,
		}) => {
			const { student, project, id } = await makeChatTab(page, context);
			await page.routeWebSocket(/\/chat$/, (ws) => {
				const send = scriptedChat(ws, "00000000-0000-4000-8000-000000000000");
				send("snapshot", { cards: [], turnRunning: false, truncated: false });
				send("settings", {
					agent: "claude",
					model: "default",
					effort: "high",
					mode: "default",
				});
				const at = Date.now() - 120_000;
				send("message", { id: "u1", role: "user", markdown: "Fix the login form" });
				send("turn.started", { at });
				send("message", { id: "a1", role: "assistant", markdown: "Looking first." });
				send("tool.started", {
					id: "toolu_explore",
					name: "Agent",
					title: "Find where the login form posts",
					input: {
						description: "Find where the login form posts",
						subagent_type: "Explore",
						prompt: "Find it",
					},
				});
				send("tool.output", {
					id: "toolu_explore",
					part: { type: "text", text: "It posts to /api/session." },
				});
				send("tool.finished", { id: "toolu_explore", isError: false });
				send("tool.started", {
					id: "toolu_read",
					name: "Read",
					title: "Read a file",
					input: { file_path: "src/login.ts" },
				});
				send("tool.finished", { id: "toolu_read", isError: false });
				send("message", { id: "a2", role: "assistant", markdown: "Fixed it." });
				send("turn.finished", { at: at + 60_000, status: "done" });
			});
			await page.reload();
			const view = page.getByTestId(`chat-view-${id}`);
			await expect(view.getByText("Fixed it.")).toBeVisible({ timeout: 15_000 });
			// The tool row is folded away, but in the page.
			const row = view.locator('details[data-testid="chat-tool-toolu_explore"]');
			await expect(row).toBeAttached();
			await expect(row).toBeHidden();

			// A shell takes the screen, so the chat is out of sight.
			await newTerminal(page);
			await expect(view).toBeHidden();

			await setAgentTabs(student.workspaceId, [
				{
					terminalId: id,
					agent: "claude",
					state: "finished",
					subagents: [
						{
							id: "toolu_explore",
							type: "Explore",
							description: "Find where the login form posts",
							state: "finished",
						},
					],
				},
			]);
			const rows = page.getByRole("list", { name: "Agents in Dashboard" });
			await expect(
				rows.getByRole("link", { name: /Claude Code \(GUI\)/ }),
			).toBeVisible();
			await rows
				.getByRole("link", { name: /^Find where the login form posts/ })
				.click();

			await expect(view).toBeVisible();
			// The subagent's own conversation opens over the chat; closing it lands on its tool row.
			const panel = view.getByTestId("subagent-panel");
			await expect(panel.getByRole("heading", { level: 2 })).toBeFocused();
			await page.keyboard.press("Escape");
			await expect(panel).toHaveCount(0);
			await expect(row).toHaveJSProperty("open", true);
			await expect(row.locator("> summary")).toBeFocused();
			await expect(row).toBeInViewport();
			await expect(view.getByText("It posts to /api/session.")).toBeVisible();
			await expectPlainUrl(page, project.id);
		});

		test("at phone width the rows are in the Projects drawer, and a row closes it", async ({
			page,
			context,
		}) => {
			await page.setViewportSize({ width: 390, height: 844 });
			const student = await createStudent(context);
			const project = await createProject(student.workspaceId, {
				name: "A project with a long name for a narrow drawer",
			});
			await page.goto(workspacePath(student.workspaceId, project.id));
			await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
			const agent = await startClaude(page, student.workspaceId, project.id);
			await newTerminal(page);
			await expect
				.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
				.toBe(2);
			const shell = (await terminalIds(student.workspaceId, project.id)).find(
				(one) => one !== agent,
			);
			if (!shell) throw new Error("no shell");
			// A shell that connects late takes the keyboard, which closes an open drawer.
			await expectConnected(page, shell);
			await setAgentTabs(student.workspaceId, [
				{
					terminalId: agent,
					agent: "claude",
					state: "needs-input",
					since: minutesAgo(12),
					subagents: [
						{
							id: "toolu_long",
							type: "general-purpose",
							description:
								"Read every test in the project and list the ones that never assert anything",
							state: "working",
						},
					],
				},
			]);

			await page.getByRole("button", { name: "Projects", exact: true }).click();
			const drawer = page.getByRole("dialog", { name: "Projects" });
			const rows = drawer.getByRole("list", {
				name: "Agents in A project with a long name for a narrow drawer",
			});
			const agentRow = rows.getByRole("link", { name: /Claude Code \(TUI\)/ });
			await expect(agentRow).toContainText("Needs input 12m");
			// Nothing spills out of the drawer, however long the words.
			await expect
				.poll(() => drawer.evaluate((node) => node.scrollWidth <= node.clientWidth))
				.toBe(true);
			await expectNoViolations(page, '[data-testid="project-list"]');
			await page.screenshot({
				path: `screenshots/agent-rows-phone-${colorScheme}.png`,
			});

			await agentRow.click();
			await expect(drawer).toBeHidden();
			await expect(
				page.getByRole("tab", { name: /^Claude Code \(TUI\)/ }),
			).toHaveAttribute("aria-selected", "true");
		});
	});
}

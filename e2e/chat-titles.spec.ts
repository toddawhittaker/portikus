import { expect, test } from "@playwright/test";
import { launchChat, receivedFrames } from "./chat-helpers";
import {
	createProject,
	createStudent,
	expectNoViolations,
	newTerminal,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * A chat's conversation title in the left pane and on its tab, renamed with
 * the row's pencil or with /rename in the chat (SPEC.md §8.2, §10.8; ADR
 * 0074). The fake agent stands in for the chat host's title posts: a rename
 * on the chat socket, or a /rename message, retitles the reported list.
 */

interface AgentTab {
	terminalId: string;
	agent: "claude";
	state: "working" | "needs-input" | "finished";
	title?: string;
	subagents?: {
		id: string;
		type: string;
		description: string;
		state: "working" | "finished";
	}[];
}

async function setAgentTabs(workspaceId: string, terminals: AgentTab[]): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/coding-agents`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, terminals }),
	});
	if (!response.ok) throw new Error(`the fake agent refused: ${response.status}`);
}

for (const colorScheme of ["dark", "light"] as const) {
	test(`two chats show their own titles, and the pencil and /rename retitle them (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme });
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Quiz" });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
		const first = await launchChat(page, student.workspaceId, project.id);
		const second = await launchChat(page, student.workspaceId, project.id);
		// A terminal tab running Claude Code keeps its name and has no pencil.
		await newTerminal(page);
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
			.toBe(3);
		const tui = (await terminalIds(student.workspaceId, project.id)).find(
			(one) => one !== first.id && one !== second.id,
		);
		if (!tui) throw new Error("no terminal tab");

		await setAgentTabs(student.workspaceId, [
			{
				terminalId: first.id,
				agent: "claude",
				state: "finished",
				title: "Fix the login redirect",
			},
			{
				terminalId: second.id,
				agent: "claude",
				state: "working",
				title: "Write the README",
				subagents: [
					{
						id: "toolu_explore",
						type: "Explore",
						description: "Find the install steps",
						state: "working",
					},
				],
			},
			{ terminalId: tui, agent: "claude", state: "working" },
		]);

		const rows = page.getByRole("list", { name: "Agents in Quiz" });
		const firstRow = page.getByTestId(`agent-row-${first.id}`);
		const secondRow = page.getByTestId(`agent-row-${second.id}`);
		await expect(firstRow).toContainText("Fix the login redirect");
		await expect(firstRow).toContainText("Claude Code (GUI)");
		await expect(firstRow).toContainText("Finished");
		await expect(secondRow).toContainText("Write the README");
		// A subagent's summary is the description its Agent call gave.
		await expect(
			rows.getByRole("link", { name: "Find the install steps Explore (working)" }),
		).toBeVisible();
		// Each chat tab is labelled with its own title; the terminal tab keeps its name.
		await expect(
			page.getByRole("tab", { name: /^Fix the login redirect/ }),
		).toBeVisible();
		await expect(page.getByRole("tab", { name: /^Write the README/ })).toBeVisible();
		await expect(page.getByRole("tab", { name: /^Terminal/ })).toBeVisible();
		await expect(page.getByTestId(`agent-row-${tui}`)).toContainText(
			"Claude Code (TUI)",
		);
		await expect(page.getByTestId(`agent-rename-${tui}`)).toHaveCount(0);
		await expect(page.getByTestId(`agent-title-${tui}`)).toHaveCount(0);
		await expectNoViolations(page, '[data-testid="project-list"]');
		await page.screenshot({ path: `screenshots/chat-titles-${colorScheme}.png` });

		// Escape leaves the title as it was and sends nothing.
		await page.getByRole("button", { name: "Rename Fix the login redirect" }).click();
		const input = page.getByRole("textbox", { name: "Title of Claude Code (GUI)" });
		await expect(input).toBeFocused();
		await expect(input).toHaveValue("Fix the login redirect");
		await input.fill("Not this");
		await input.press("Escape");
		await expect(input).toHaveCount(0);
		await expect(firstRow).toContainText("Fix the login redirect");
		await expect(
			page.getByRole("button", { name: "Rename Fix the login redirect" }),
		).toBeFocused();

		// Enter renames: the host gets one rename, and the row and the tab follow.
		await page.getByRole("button", { name: "Rename Fix the login redirect" }).click();
		await input.fill("Grade the quiz");
		await input.press("Enter");
		await expect(firstRow).toContainText("Grade the quiz");
		await expect(page.getByRole("tab", { name: /^Grade the quiz/ })).toBeVisible();
		await expect
			.poll(() => receivedFrames(first.id, "rename"))
			.toEqual([{ type: "rename", title: "Grade the quiz" }]);

		// /rename typed in the other chat retitles its row and tab the same way.
		await page.getByRole("tab", { name: /^Write the README/ }).click();
		const box = second.view.getByTestId("chat-composer-input");
		await box.fill("/rename Heron notes");
		await box.press("Enter");
		await expect(
			second.view.getByText("Session renamed to: Heron notes"),
		).toBeVisible();
		await expect(secondRow).toContainText("Heron notes");
		await expect(page.getByRole("tab", { name: /^Heron notes/ })).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Rename Heron notes" }),
		).toBeVisible();
	});
}

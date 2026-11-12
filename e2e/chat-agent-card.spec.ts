import { expect, test } from "@playwright/test";
import { makeChatTab, scriptedChat } from "./chat-helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * The Agent tool card in the Claude Code (GUI) chat (SPEC.md §8.2, §8.3): a
 * background launch shows a plain status and the prompt, with the text Claude
 * Code wrote for the model never shown; an Agent card has no Raw input or Raw
 * output; a foreground subagent keeps its reply.
 */

const LAUNCH_TEXT =
	"Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: a1b2c3d4 (internal ID - do not mention to user.)\noutput_file: /tmp/claude-1000/a1b2c3d4.output Do NOT Read or tail this file";

async function setSubagent(
	workspaceId: string,
	terminalId: string,
	state: "working" | "finished",
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
					state: "working",
					subagents: [
						{
							id: "toolu_bg",
							type: "Explore",
							description: "Find where the login form posts",
							state,
						},
					],
				},
			],
		}),
	});
	if (!response.ok) throw new Error(`the fake agent refused: ${response.status}`);
}

test("a background Agent card shows its status and prompt, and never shows the launch text or a raw disclosure", async ({
	page,
	context,
}) => {
	const { student, id } = await makeChatTab(page, context);
	await page.routeWebSocket(/\/chat$/, (ws) => {
		const send = scriptedChat(ws, "00000000-0000-4000-8000-000000000000");
		send("snapshot", { cards: [], turnRunning: false, truncated: false });
		send("settings", {
			agent: "claude",
			model: "default",
			effort: "high",
			mode: "default",
		});
		const at = Date.now() - 60_000;
		send("message", { id: "u1", role: "user", markdown: "Look into the login form" });
		send("turn.started", { at });
		send("tool.started", {
			id: "toolu_bg",
			name: "Agent",
			title: "Find where the login form posts",
			input: {
				description: "Find where the login form posts",
				subagent_type: "Explore",
				prompt: "Find the route the login form posts to.",
				run_in_background: true,
			},
		});
		send("tool.output", { id: "toolu_bg", part: { type: "text", text: LAUNCH_TEXT } });
		send("tool.finished", { id: "toolu_bg", isError: false });
		send("tool.started", {
			id: "toolu_fg",
			name: "Agent",
			title: "Count the routes",
			input: {
				description: "Count the routes",
				subagent_type: "Explore",
				prompt: "Count them.",
			},
		});
		send("tool.output", {
			id: "toolu_fg",
			part: { type: "text", text: "There are 12 routes." },
		});
		send("tool.finished", { id: "toolu_fg", isError: false });
		send("message", { id: "a1", role: "assistant", markdown: "Started it." });
		send("turn.finished", { at: at + 30_000, status: "done" });
	});
	await page.reload();
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(view.getByText("Started it.")).toBeVisible({ timeout: 15_000 });

	const card = view.locator('details[data-testid="chat-tool-toolu_bg"]');
	// The turn folds its work, and the two calls in a row sit under one more disclosure.
	await view.getByTestId("chat-worked").locator("> summary").click();
	await view.getByTestId("chat-tool-group").locator("> summary").click();
	await card.locator("> summary").click();
	await expect(card.getByTestId("chat-agent-status")).toHaveText(
		"Started in the background",
	);
	await expect(
		card.getByText("Find the route the login form posts to.", { exact: true }),
	).toBeVisible();
	await expect(card.getByText("internal metadata")).toBeHidden();
	await expect(card.getByText("do not mention to user")).toBeHidden();

	// The state is the one the project list shows for the same subagent.
	await setSubagent(student.workspaceId, id, "working");
	await expect(card.getByTestId("chat-agent-status")).toHaveText(
		"Started in the background · working",
	);
	await setSubagent(student.workspaceId, id, "finished");
	await expect(card.getByTestId("chat-agent-status")).toHaveText(
		"Started in the background · finished",
	);

	// Neither raw disclosure exists on an Agent card, so the launch text is nowhere.
	await expect(card.getByText("Raw output")).toHaveCount(0);
	await expect(card.getByText("Raw input")).toHaveCount(0);
	await expect(card.locator("details.pk-chat-raw")).toHaveCount(0);
	await expect(card.getByText("internal metadata")).toHaveCount(0);

	// A foreground subagent keeps showing its reply.
	const foreground = view.locator('details[data-testid="chat-tool-toolu_fg"]');
	await foreground.locator("> summary").click();
	await expect(foreground.getByText("There are 12 routes.")).toBeVisible();
	await expect(foreground.getByTestId("chat-agent-status")).toHaveCount(0);
	await expect(foreground.getByText("Raw output")).toHaveCount(0);
	await expect(foreground.getByText("Raw input")).toHaveCount(0);
});

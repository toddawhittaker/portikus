import { expect, type Locator, type Page, test } from "@playwright/test";
import { openChat, openChatOptions } from "./chat-helpers";
import { createStudent, expectNoViolations, query } from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * Swapping the agent of a chat with history (SPEC.md §10.8): the other
 * agent is offered with a warning, the picker shows it while it starts,
 * the composer says so, and the chat keeps its tab with a divider where
 * the agent changed. Against the fake agent's chat through the API relay;
 * the fake replaces the host by closing every attachment, as the real
 * workspace agent does.
 */

const WARNING =
	"Codex starts fresh with this conversation as context; the cache is lost. If the conversation is too long for Codex, its oldest turns are left out.";

/** How the fake's next swap goes: turns it drops, a delay, or a refusal. */
async function nextSwap(
	id: string,
	swap: { droppedTurns?: number; delayMs?: number; refuse?: boolean },
): Promise<void> {
	const set = await fetch(`${FAKE_AGENT_URL}/__test/chats/${id}/swap`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(swap),
	});
	expect(set.status).toBe(204);
}

function agentMenu(page: Page): Locator {
	return page.getByRole("menu", { name: /^Agent / });
}

async function openAgentMenu(page: Page, view: Locator): Promise<Locator> {
	await expect(view.getByTestId("composer-model")).toBeAttached({ timeout: 15_000 });
	await openChatOptions(view);
	await view.getByTestId("composer-agent").click();
	return agentMenu(page);
}

async function rowAgent(id: string): Promise<string> {
	const rows = await query<{ agent: string }>(
		"select agent from terminals where id = $1",
		[id],
	);
	return rows[0]?.agent ?? "";
}

test("a chat with history swaps to Codex and back in its own tab, with a divider that a reload keeps", async ({
	page,
	context,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "Swap");
	// The fake's chat starts with one earlier turn, so it has history.
	await expect(view.getByText("Earlier answer")).toBeVisible();
	await nextSwap(id, { delayMs: 1500 });

	const codex = (await openAgentMenu(page, view)).getByRole("menuitemradio", {
		name: "Codex",
	});
	await expect(codex).not.toHaveAttribute("aria-disabled", "true");
	await expect(codex).toHaveAccessibleDescription(WARNING);
	await expect(codex.locator("svg[data-icon='alert']")).toBeVisible();
	await codex.click();

	// While the swap is pending the picker shows Codex, busy, and the composer says it is switching.
	await expect(view.getByTestId("composer-agent")).toHaveText("Agent Codex");
	await expect(view.getByTestId("composer-agent")).toHaveAttribute("aria-busy", "true");
	await expect(view.getByTestId("chat-composer-status")).toHaveText(
		"Switching to Codex…",
	);

	const divider = view.getByTestId("chat-handoff");
	await expect(divider).toHaveText(
		"Switched from Claude Code to Codex. Codex started fresh with this conversation as context.",
		{ timeout: 15_000 },
	);
	await expect(view.getByTestId("chat-composer-input")).toHaveAttribute(
		"aria-label",
		"Message Codex",
	);
	await expect(page.getByRole("tab", { name: /Codex \(GUI\)/ })).toBeVisible();
	await expect.poll(() => rowAgent(id)).toBe("codex");
	// Once Codex reports its settings the pickers are back, and the status says so.
	await expect(view.getByTestId("composer-agent")).not.toHaveAttribute("aria-busy");
	await expect(view.getByTestId("chat-composer-status")).toHaveText(
		"Now chatting with Codex",
	);
	// The earlier turn keeps Claude's byline.
	const log = view.getByRole("list", { name: "Conversation" });
	await expect(log.getByText("Claude", { exact: true })).toBeVisible();
	await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);

	// A reload finds the same tab running Codex, with the divider still in place.
	await page.reload();
	const again = page.getByTestId(`chat-view-${id}`);
	await expect(again.getByTestId("chat-handoff")).toBeVisible({ timeout: 15_000 });
	await expect(again.getByTestId("chat-composer-input")).toHaveAttribute(
		"aria-label",
		"Message Codex",
	);

	// Back to Claude, with the oldest turns left out this time.
	await nextSwap(id, { droppedTurns: 2 });
	const claude = (await openAgentMenu(page, again)).getByRole("menuitemradio", {
		name: "Claude Code",
	});
	await expect(claude).toHaveAccessibleDescription(
		"Claude Code starts fresh with this conversation as context; the cache is lost. If the conversation is too long for Claude Code, its oldest turns are left out.",
	);
	await claude.click();
	await expect(again.getByTestId("chat-handoff")).toHaveCount(2, { timeout: 15_000 });
	await expect(again.getByTestId("chat-handoff").nth(1)).toHaveText(
		"Switched from Codex to Claude Code. Claude Code started fresh with this conversation as context. The 2 oldest turns did not fit Claude Code’s context window and were left out.",
	);
	await expect(page.getByRole("tab", { name: /Claude Code \(GUI\)/ })).toBeVisible();
	await expect.poll(() => rowAgent(id)).toBe("claude");
});

test("a refused swap leaves the chat on its agent and says why", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "Refused swap");
	await nextSwap(id, { refuse: true });
	const menu = await openAgentMenu(page, view);
	await menu.getByRole("menuitemradio", { name: "Codex" }).click();
	await expect(view.getByTestId("chat-composer-status")).toHaveText(
		"The agent did not change. Wait for the reply to finish before switching agents.",
	);
	await expect(view.getByTestId("composer-agent")).toHaveText("Agent Claude Code");
	await expect(view.getByTestId("chat-handoff")).toHaveCount(0);
	expect(await rowAgent(id)).toBe("claude");
});

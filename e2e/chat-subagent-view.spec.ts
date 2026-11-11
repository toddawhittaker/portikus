import { expect, type Page, test } from "@playwright/test";
import { makeChatTab, scriptedChat } from "./chat-helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * A subagent's own conversation in the Claude Code (GUI) chat (SPEC.md §8.2,
 * §8.3, §10.8, §25.8): a panel over the chat's log, opened from a background
 * Agent card or the subagent's row in the project list. It is read-only and
 * says how to pass a message on; it updates live, opens a nested subagent
 * with Back, and gives the keyboard back when Escape closes it.
 */

const SESSION = "00000000-0000-4000-8000-000000000000";
const LAUNCH_TEXT =
	"Async agent launched successfully.\nagentId: a1b2c3d4 (internal ID - do not mention to user.)";

type Send = (type: string, body?: Record<string, unknown>) => void;

/** One background Agent call, as the chat shows it. */
function agentCall(send: Send, id: string, title: string) {
	send("tool.started", {
		id,
		name: "Agent",
		title,
		input: { description: title, prompt: `${title}, please.`, run_in_background: true },
	});
	send("tool.output", { id, part: { type: "text", text: LAUNCH_TEXT } });
	send("tool.finished", { id, isError: false });
}

/**
 * The chat socket, answered by a script: one finished turn that started a
 * background subagent. Each watch gets that subagent's conversation so far;
 * `live` sends more to whoever watches it now.
 */
async function scriptSubagentChat(page: Page) {
	const watched: { type: string; toolUseId: string }[] = [];
	let toWatcher: ((toolUseId: string, type: string, body: object) => void) | null =
		null;
	await page.routeWebSocket(/\/chat$/, (ws) => {
		const send = scriptedChat(ws, SESSION);
		const seqs = new Map<string, number>();
		toWatcher = (toolUseId, type, body) => {
			const seq = seqs.get(toolUseId) ?? 0;
			seqs.set(toolUseId, seq + 1);
			send("subagent", {
				toolUseId,
				event: { type, sessionId: SESSION, seq, ...body },
			});
		};
		const sub =
			(toolUseId: string): Send =>
			(type, body = {}) =>
				toWatcher?.(toolUseId, type, body);
		send("snapshot", { cards: [], turnRunning: false, truncated: false });
		send("settings", {
			agent: "claude",
			model: "default",
			effort: "high",
			mode: "default",
		});
		const at = Date.now() - 60_000;
		send("message", { id: "u1", role: "user", markdown: "Look into the routes" });
		send("turn.started", { at });
		agentCall(send, "toolu_bg", "Count the routes");
		send("message", { id: "a1", role: "assistant", markdown: "Started it." });
		send("turn.finished", { at: at + 5_000, status: "done" });
		ws.onMessage((raw) => {
			const message = JSON.parse(String(raw)) as { type: string; toolUseId: string };
			if (!message.type.startsWith("subagent.")) return;
			watched.push(message);
			if (message.type !== "subagent.watch") return;
			const id = message.toolUseId;
			seqs.set(id, 0);
			const to = sub(id);
			if (id === "toolu_bg") {
				to("snapshot", { cards: [], turnRunning: true, truncated: false });
				to("turn.started", { at });
				to("message", { id: "p", role: "user", markdown: "Count the routes, please." });
				to("tool.started", {
					id: "toolu_ls",
					name: "Bash",
					title: "List the routes",
					input: { command: "ls src/routes", description: "List the routes" },
				});
				to("tool.output", {
					id: "toolu_ls",
					part: { type: "text", text: "a.ts\nb.ts" },
				});
				to("tool.finished", { id: "toolu_ls", isError: false });
				agentCall(to, "toolu_nested", "Read the router");
			} else if (id === "toolu_nested") {
				to("snapshot", { cards: [], turnRunning: false, truncated: false });
				to("turn.started", { at });
				to("message", { id: "np", role: "user", markdown: "Read the router, please." });
				to("message", {
					id: "nr",
					role: "assistant",
					markdown: "The router has 2 routes.",
				});
				to("turn.finished", { at: at + 2_000, status: "done" });
			}
		});
	});
	return {
		watched,
		live: (toolUseId: string, type: string, body: object) =>
			toWatcher?.(toolUseId, type, body),
	};
}

async function setSubagentRow(workspaceId: string, terminalId: string): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/coding-agents`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			key: workspaceId,
			terminals: [
				{
					terminalId,
					agent: "claude",
					state: "finished",
					subagents: [
						{
							id: "toolu_bg",
							type: "general-purpose",
							description: "Count the routes",
							state: "working",
						},
					],
				},
			],
		}),
	});
	if (!response.ok) throw new Error(`the fake agent refused: ${response.status}`);
}

for (const colorScheme of ["dark", "light"] as const) {
	test.describe(`subagent view (${colorScheme})`, () => {
		test.describe.configure({ timeout: 90_000 });

		test.beforeEach(async ({ page }) => {
			await page.emulateMedia({ colorScheme });
		});

		test("the Agent card opens a live, read-only panel with nested subagents, and Escape closes it", async ({
			page,
			context,
		}) => {
			const { id } = await makeChatTab(page, context);
			const host = await scriptSubagentChat(page);
			await page.reload();
			const view = page.getByTestId(`chat-view-${id}`);
			await expect(view.getByText("Started it.")).toBeVisible({ timeout: 15_000 });

			await view.getByTestId("chat-worked").locator("> summary").click();
			const card = view.locator('details[data-testid="chat-tool-toolu_bg"]');
			await card.locator("> summary").click();
			const show = card.getByRole("button", { name: "Show its conversation" });
			await show.click();

			const panel = view.getByRole("region", { name: "Subagent Count the routes" });
			await expect(panel).toBeVisible();
			await expect(panel.getByRole("heading", { level: 2 })).toBeFocused();
			await expect(panel.getByTestId("subagent-note")).toHaveText(
				"Read only. Claude Code cannot send a subagent a message; to pass one on, ask Claude in the chat below.",
			);
			// The development build mounts twice, so only the last message counts.
			await expect
				.poll(() => host.watched.at(-1))
				.toEqual({ type: "subagent.watch", toolUseId: "toolu_bg" });
			await expect(panel.getByText("Count the routes, please.")).toBeVisible();
			await expect(panel.getByTestId("chat-tool-toolu_ls")).toBeAttached();
			// The composer stays in reach below the panel.
			await expect(view.getByTestId("chat-composer-input")).toBeVisible();

			// It updates live.
			host.live("toolu_bg", "message", {
				id: "r",
				role: "assistant",
				markdown: "There are 2 routes.",
			});
			host.live("toolu_bg", "turn.finished", { at: Date.now(), status: "done" });
			await expect(panel.getByText("There are 2 routes.")).toBeVisible();
			await expect(panel.getByTestId("subagent-announcer")).toHaveText(
				"The subagent finished.",
			);
			// None of it is in the chat's own log.
			await expect(
				view.getByTestId("chat-scroll").getByText("There are 2 routes."),
			).toHaveCount(0);

			// A nested subagent opens in the same panel, and Back returns.
			// Its finished run folds its steps, as the chat folds a turn's.
			await panel.getByTestId("chat-worked").locator("> summary").click();
			const group = panel.getByTestId("chat-tool-group");
			if ((await group.count()) > 0) await group.locator("> summary").click();
			const nested = panel.locator('details[data-testid="chat-tool-toolu_nested"]');
			await nested.locator("> summary").click();
			await nested.getByRole("button", { name: "Show its conversation" }).click();
			const inner = view.getByRole("region", { name: "Subagent Read the router" });
			await expect(inner.getByText("The router has 2 routes.")).toBeVisible();
			await expect(inner.getByRole("heading", { level: 2 })).toBeFocused();
			const back = inner.getByRole("button", { name: "Back to Count the routes" });
			await back.press("Enter");
			await expect(panel.getByRole("heading", { level: 2 })).toBeFocused();
			await expect(panel.getByTestId("subagent-back")).toHaveCount(0);

			// Escape closes it and gives the keyboard back to the card's button.
			await page.keyboard.press("Escape");
			await expect(view.getByTestId("subagent-panel")).toHaveCount(0);
			await expect(show).toBeFocused();
			await expect
				.poll(() => host.watched.at(-1))
				.toEqual({
					type: "subagent.unwatch",
					toolUseId: "toolu_bg",
				});
		});

		test("a subagent's row in the project list opens its panel, and closing it lands on the Agent card", async ({
			page,
			context,
		}) => {
			const { student, id } = await makeChatTab(page, context);
			await scriptSubagentChat(page);
			await page.reload();
			const view = page.getByTestId(`chat-view-${id}`);
			await expect(view.getByText("Started it.")).toBeVisible({ timeout: 15_000 });
			await setSubagentRow(student.workspaceId, id);

			const rows = page.getByRole("list", { name: "Agents in Dashboard" });
			await rows.getByRole("link", { name: /^Count the routes/ }).click();
			const panel = view.getByRole("region", { name: "Subagent Count the routes" });
			await expect(panel.getByRole("heading", { level: 2 })).toBeFocused();
			await expect(panel.getByText("Count the routes, please.")).toBeVisible();

			await panel.getByRole("button", { name: "Close the subagent view" }).click();
			await expect(view.getByTestId("subagent-panel")).toHaveCount(0);
			const card = view.locator('details[data-testid="chat-tool-toolu_bg"]');
			await expect(card).toHaveJSProperty("open", true);
			await expect(card.locator("> summary")).toBeFocused();
		});
	});
}

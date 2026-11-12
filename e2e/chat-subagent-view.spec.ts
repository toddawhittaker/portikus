import {
	type BrowserContext,
	expect,
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import { makeChatTab, scriptedChat } from "./chat-helpers";
import { expectNoViolations, terminalIds } from "./helpers";
import { FAKE_AGENT_URL } from "./ports";
import { splitPane } from "./split-helpers";

/**
 * A subagent's own conversation in the Claude Code (GUI) chat (SPEC.md §8.2,
 * §8.3, §10.8, §25.8): a sheet docked to the right of the chat's log, about
 * half the pane, opened from a background Agent card or the subagent's row in
 * the project list. The log stays usable beside it; a pane too narrow for
 * both gives the sheet all of it. It is read-only and says how to pass a
 * message on; it updates live, opens a nested subagent with Back, and gives
 * the keyboard back when Escape closes it. The chat's own row closes it.
 */

/** Below this pane width the sheet covers all but a strip of the log (28rem). */
const SIDE_BY_SIDE = 28 * 16;
/** The strip of the log a covering sheet leaves in view (3rem). */
const STRIP = 3 * 16;

/** Open the background subagent's sheet from its Agent card. */
async function openBackgroundCard(view: Locator) {
	await view.getByTestId("chat-worked").locator("> summary").click();
	await view.getByTestId("chat-tool-group").locator("> summary").click();
	const card = view.locator('details[data-testid="chat-tool-toolu_bg"]');
	await card.locator("> summary").click();
	await card.getByRole("button", { name: "Show its conversation" }).click();
	const panel = view.getByRole("region", { name: "Subagent Count the routes" });
	await expect(panel.getByText("Count the routes, please.")).toBeVisible();
	return panel;
}

/** The focus ring's width in pixels, from the theme. */
async function ringWidth(page: Page): Promise<number> {
	return page.evaluate(() =>
		Number.parseFloat(
			getComputedStyle(document.documentElement).getPropertyValue("--ring-width"),
		),
	);
}

/** A chat in a tab split with a terminal, its sheet open: a narrower pane. */
async function openSplit(page: Page, context: BrowserContext, width: number) {
	await page.setViewportSize({ width, height: 900 });
	const { student, project, id } = await makeChatTab(page, context);
	await scriptSubagentChat(page);
	await page.reload();
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(view.getByText("Started it.")).toBeVisible({ timeout: 15_000 });
	await splitPane(page, id, "right");
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(2);
	const panel = await openBackgroundCard(view);
	return { id, view, panel };
}

async function box(locator: Locator) {
	const found = await locator.boundingBox();
	if (!found) throw new Error("the element has no box");
	return found;
}

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
		// A foreground subagent: its call returns the subagent's reply.
		send("tool.started", {
			id: "toolu_fg",
			name: "Agent",
			title: "Check the tests",
			input: { description: "Check the tests", prompt: "Check the tests, please." },
		});
		send("tool.output", {
			id: "toolu_fg",
			part: { type: "text", text: "All 12 pass." },
		});
		send("tool.finished", { id: "toolu_fg", isError: false });
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
			} else if (id === "toolu_fg") {
				to("snapshot", { cards: [], turnRunning: false, truncated: false });
				to("turn.started", { at });
				to("message", { id: "fp", role: "user", markdown: "Check the tests, please." });
				to("message", { id: "fr", role: "assistant", markdown: "All 12 pass." });
				to("turn.finished", { at: at + 1_000, status: "done" });
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
			// The two Agent calls in a row sit under one more disclosure.
			await view.getByTestId("chat-tool-group").locator("> summary").click();
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

		test("a foreground Agent card opens its subagent's conversation too", async ({
			page,
			context,
		}) => {
			const { id } = await makeChatTab(page, context);
			const host = await scriptSubagentChat(page);
			await page.reload();
			const view = page.getByTestId(`chat-view-${id}`);
			await expect(view.getByText("Started it.")).toBeVisible({ timeout: 15_000 });
			await view.getByTestId("chat-worked").locator("> summary").click();
			await view.getByTestId("chat-tool-group").locator("> summary").click();
			const card = view.locator('details[data-testid="chat-tool-toolu_fg"]');
			await card.locator("> summary").click();
			// It keeps its reply, and offers the conversation behind it.
			await expect(card.getByText("All 12 pass.")).toBeVisible();
			const show = card.getByRole("button", { name: "Show its conversation" });
			await show.click();
			const panel = view.getByRole("region", { name: "Subagent Check the tests" });
			await expect(panel.getByRole("heading", { level: 2 })).toBeFocused();
			await expect(panel.getByText("Check the tests, please.")).toBeVisible();
			await expect
				.poll(() => host.watched.at(-1))
				.toEqual({ type: "subagent.watch", toolUseId: "toolu_fg" });
			await page.keyboard.press("Escape");
			await expect(show).toBeFocused();
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
		test("in a wide pane the sheet takes the right half, the log stays usable, and the chat's row closes it", async ({
			page,
			context,
		}) => {
			await page.setViewportSize({ width: 1600, height: 900 });
			const { student, id } = await makeChatTab(page, context);
			await scriptSubagentChat(page);
			await page.reload();
			const view = page.getByTestId(`chat-view-${id}`);
			await expect(view.getByText("Started it.")).toBeVisible({ timeout: 15_000 });
			await setSubagentRow(student.workspaceId, id);
			const panel = await openBackgroundCard(view);

			const pane = await box(view);
			expect(pane.width).toBeGreaterThanOrEqual(SIDE_BY_SIDE);
			const sheet = await box(panel);
			// min(50%, 40rem), at least 14rem, docked inside the pane's right edge and its ring.
			const wanted = Math.min(Math.max(pane.width / 2, 14 * 16), 40 * 16);
			expect(Math.abs(sheet.width - wanted)).toBeLessThanOrEqual(1);
			const ring = await ringWidth(page);
			expect(
				Math.abs(sheet.x + sheet.width - (pane.x + pane.width - ring)),
			).toBeLessThanOrEqual(1);
			expect(sheet.x).toBeGreaterThanOrEqual(pane.x);
			expect(sheet.y).toBeGreaterThanOrEqual(pane.y);
			expect(sheet.y + sheet.height).toBeLessThanOrEqual(pane.y + pane.height);

			// The conversation stays in view to its left, and answers clicks.
			const log = view.getByTestId("chat-scroll");
			await expect(log).not.toHaveAttribute("inert");
			const reply = log.getByText("Started it.");
			await expect(reply).toBeVisible();
			const said = await box(reply);
			expect(said.x + said.width).toBeLessThanOrEqual(sheet.x);
			const worked = log.getByTestId("chat-worked");
			await expect(worked).toHaveJSProperty("open", true);
			await worked.locator("> summary").click();
			await expect(worked).toHaveJSProperty("open", false);
			await expect(panel).toBeVisible();
			// The composer stays usable below both.
			const composer = view.getByTestId("chat-composer-input");
			await composer.click();
			await page.keyboard.type("Hello");
			await expect(composer).toContainText("Hello");

			await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);

			// The chat's own row in the project list closes the sheet; the
			// keyboard stays on the row, where following its link leaves it.
			const row = page.getByTestId(`agent-row-${id}`);
			await row.click();
			await expect(view.getByTestId("subagent-panel")).toHaveCount(0);
			await expect(row).toBeFocused();

			// A subagent row still opens it, and Enter on the chat's row closes it.
			const rows = page.getByRole("list", { name: "Agents in Dashboard" });
			await rows.getByRole("link", { name: /^Count the routes/ }).click();
			await expect(panel.getByRole("heading", { level: 2 })).toBeFocused();
			await row.focus();
			await page.keyboard.press("Enter");
			await expect(view.getByTestId("subagent-panel")).toHaveCount(0);
			await expect(row).toBeFocused();
		});

		test("in a split pane down to 28rem the sheet still sits beside a usable log", async ({
			page,
			context,
		}) => {
			const { id, view, panel } = await openSplit(page, context, 1600);
			const pane = await box(view);
			expect(pane.width).toBeGreaterThanOrEqual(SIDE_BY_SIDE);
			const sheet = await box(panel);
			const wanted = Math.min(Math.max(pane.width / 2, 14 * 16), 40 * 16);
			expect(Math.abs(sheet.width - wanted)).toBeLessThanOrEqual(1);
			const log = view.getByTestId("chat-scroll");
			await expect(log).not.toHaveAttribute("inert");
			const reply = log.getByText("Started it.");
			await expect(reply).toBeVisible();
			expect((await box(reply)).x + (await box(reply)).width).toBeLessThanOrEqual(
				sheet.x,
			);
			await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);
		});

		test("in a pane under 28rem the sheet covers all but a strip of the log, which takes no input", async ({
			page,
			context,
		}) => {
			const { id, view, panel } = await openSplit(page, context, 1100);
			const pane = await box(view);
			expect(pane.width).toBeLessThan(SIDE_BY_SIDE);
			const sheet = await box(panel);
			const ring = await ringWidth(page);
			// A strip of the conversation shows on the left; the sheet is inside the ring.
			expect(Math.abs(sheet.x - (pane.x + STRIP))).toBeLessThanOrEqual(1);
			expect(
				Math.abs(sheet.x + sheet.width - (pane.x + pane.width - ring)),
			).toBeLessThanOrEqual(1);
			// It reads as a panel over the chat: a border on its left and a shadow.
			await expect(panel).toHaveCSS("border-left-style", "solid");
			expect(
				await panel.evaluate((element) => getComputedStyle(element).boxShadow),
			).not.toBe("none");
			const log = view.getByTestId("chat-scroll");
			await expect(log).toBeVisible();
			await expect(log).toHaveAttribute("inert", "");
			await expect(view.getByTestId("chat-composer-input")).toBeVisible();
			await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);

			await page.keyboard.press("Escape");
			await expect(view.getByTestId("subagent-panel")).toHaveCount(0);
			await expect(log).not.toHaveAttribute("inert");
		});
	});
}

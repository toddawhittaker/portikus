import {
	type BrowserContext,
	expect,
	type Locator,
	type Page,
	test,
	type WebSocketRoute,
} from "@playwright/test";
import { type ChatAgent, inBothThemes, openChat, receivedFrames } from "./chat-helpers";
import { createStudent, expectNoViolations } from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * The side conversation beside a chat (SPEC.md §10.2, §25.8, ADR 0083):
 * `/btw` opens it from the command menu when, and only when, the host lists
 * the command. Its questions and answers never enter the main conversation,
 * it takes one question at a time, Stop ends the running question and Close
 * forgets the conversation, and the host replays it after a reload. The
 * fake host stands in for both agents' hosts.
 */

const AGENTS: { agent: ChatAgent; name: string }[] = [
	{ agent: "claude", name: "Claude Code" },
	{ agent: "codex", name: "Codex" },
];

const QUESTION = "Which file holds the parser?";
const ANSWER = `Side answer to: ${QUESTION}`;

/** An answer that never comes by itself, so a question stays running until a test stops it. */
const NEVER = 600_000;

/** Offer `btw` or not, and set how long the host takes to answer. */
async function configureSide(
	id: string,
	body: { offered?: boolean; answers?: boolean; delayMs?: number },
): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/chats/${id}/side`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(response.status).toBe(204);
}

/** Start or finish a main turn that stays open until the test ends it. */
async function mainTurn(id: string, action: "start" | "finish"): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/chats/${id}/main-turn`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action }),
	});
	expect(response.status).toBe(204);
}

/** The `side.*` frames the host has received, as the browser sent them. */
async function sideFrames(id: string): Promise<Record<string, unknown>[]> {
	return (await receivedFrames(id)).filter((frame) =>
		String(frame.type).startsWith("side."),
	);
}

/** A chat of the given agent in a new student's workspace; the host lists `btw` unless told not to. */
async function openSideChat(
	page: Page,
	context: BrowserContext,
	agent: ChatAgent,
	{ offered = true, delayMs = 0 } = {},
) {
	const student = await createStudent(context);
	const chat = await openChat(page, student.workspaceId, "Side", agent);
	await configureSide(chat.id, { offered, delayMs });
	return chat;
}

/** Open the pane the way a student does: type `/btw` and choose it from the menu. */
async function openPane(page: Page, view: Locator) {
	await view.getByTestId("chat-composer-input").click();
	await page.keyboard.type("/btw");
	const choice = view.getByRole("option", { name: /\/btw/ });
	await expect(choice).toBeVisible();
	await page.keyboard.press("Enter");
	const pane = view.getByTestId("side-panel");
	await expect(pane).toBeVisible();
	return pane;
}

/** Ask in the pane's own box. */
async function ask(pane: Locator, text: string) {
	const box = pane.getByTestId("side-composer");
	await box.fill(text);
	await box.press("Enter");
}

/** Press `key` until the target has the keyboard; a few presses at most, so a trap fails. */
async function tabTo(page: Page, target: Locator, key: "Tab" | "Shift+Tab") {
	for (let presses = 0; presses < 6; presses += 1) {
		await page.keyboard.press(key);
		if (await target.evaluate((node) => node === document.activeElement)) return;
	}
	await expect(target).toBeFocused();
}

/** Reload the page and wait until the chat has drawn its settings again. */
async function reload(page: Page, view: Locator) {
	await page.reload();
	await expect(view.getByTestId("composer-model")).toBeAttached({ timeout: 15_000 });
}

for (const { agent, name } of AGENTS) {
	test.describe(`${name} (GUI) side conversation`, () => {
		test("/btw from the command menu opens the pane titled with the chat's name and puts the keyboard in its box", async ({
			page,
			context,
		}) => {
			const { id, view } = await openSideChat(page, context, agent);
			await expect(view.getByTestId("side-panel")).toHaveCount(0);
			const pane = await openPane(page, view);
			// A labelled region whose heading is the title (SPEC.md §25.8).
			await expect(view.getByRole("region", { name: `Side: ${name}` })).toBeVisible();
			await expect(pane.getByRole("heading", { name: `Side: ${name}` })).toBeVisible();
			await expect(pane.getByTestId("side-composer")).toBeFocused();
			// Opening it asks nothing and sends nothing of its own.
			expect(await sideFrames(id)).toEqual([]);
			// The command text did not stay in the main box or go to the agent.
			await expect(view.getByTestId("chat-composer-input")).not.toContainText("/btw");
			expect(await receivedFrames(id, "send")).toEqual([]);
		});

		test("a side answer arrives while a main turn runs, and the main transcript gains nothing from it", async ({
			page,
			context,
		}) => {
			const { id, view } = await openSideChat(page, context, agent);
			await mainTurn(id, "start");
			await expect(view.getByTestId("chat-composer-stop")).toBeVisible();
			const main = view.getByTestId("chat-scroll");
			await expect(main).toContainText("Main question");
			const pane = await openPane(page, view);
			await ask(pane, QUESTION);
			await expect(pane).toContainText(ANSWER);
			await expect(pane.getByTestId("side-announcer")).toHaveText("Side answer ready.");
			// The question and its answer are in the pane alone; the main turn still runs.
			await expect(pane).toContainText(QUESTION);
			await expect(main).not.toContainText(QUESTION);
			await expect(main).not.toContainText("Side answer");
			await expect(view.getByTestId("chat-composer-stop")).toBeVisible();
			await mainTurn(id, "finish");
			await expect(main).toContainText("Main answer");
			await expect(view.getByTestId("chat-composer-stop")).toHaveCount(0);
			await expect(main).not.toContainText(QUESTION);
			await expect(main).not.toContainText("Side answer");
			// Nothing of the side conversation went to the agent as a message.
			expect(await receivedFrames(id, "send")).toEqual([]);
			expect(await sideFrames(id)).toEqual([{ type: "side.ask", text: QUESTION }]);
		});

		test("it takes one question at a time, and Stop ends the running one and frees the box", async ({
			page,
			context,
		}) => {
			const { id, view } = await openSideChat(page, context, agent, {
				delayMs: NEVER,
			});
			const pane = await openPane(page, view);
			await ask(pane, QUESTION);
			const box = pane.getByTestId("side-composer");
			const send = pane.getByTestId("side-send");
			const stop = pane.getByTestId("side-stop");
			await expect(stop).toBeVisible();
			await expect(box).toBeDisabled();
			await expect(send).toHaveAttribute("aria-disabled", "true");
			await expect(pane.getByTestId("side-announcer")).toHaveText(
				"The side question is running.",
			);
			// The disabled Ask still tells a screen reader why, and sends nothing.
			await send.click({ force: true });
			await expect(pane).not.toContainText(ANSWER);
			expect(await sideFrames(id)).toEqual([{ type: "side.ask", text: QUESTION }]);
			await stop.click();
			await expect
				.poll(async () => (await sideFrames(id)).map((f) => f.type))
				.toEqual(["side.ask", "side.stop"]);
			await expect(stop).toHaveCount(0);
			await expect(box).toBeEnabled();
			// Empty, Ask still says why it does nothing; a question frees it.
			await expect(send).toHaveAttribute("aria-disabled", "true");
			await box.fill("draft");
			await expect(send).not.toHaveAttribute("aria-disabled", "true");
			await expect(pane.getByTestId("side-announcer")).toHaveText(/stopped/);
			// A stopped question leaves the conversation, and the next one can be asked.
			await expect(pane).toContainText(QUESTION);
			await configureSide(id, { delayMs: 0 });
			await ask(pane, "And the tests?");
			await expect(pane).toContainText("Side answer to: And the tests?");
		});

		test("Close forgets the conversation, sends side.end and gives the keyboard back to the main box", async ({
			page,
			context,
		}) => {
			const { id, view } = await openSideChat(page, context, agent, {
				delayMs: NEVER,
			});
			const pane = await openPane(page, view);
			await ask(pane, QUESTION);
			await expect(pane.getByTestId("side-stop")).toBeVisible();
			await pane.getByTestId("side-close").click();
			await expect(view.getByTestId("side-panel")).toHaveCount(0);
			await expect(view.getByTestId("chat-composer-input")).toBeFocused();
			await expect
				.poll(async () => (await sideFrames(id)).map((f) => f.type))
				.toEqual(["side.ask", "side.end"]);
			// Gone for good: a reload does not bring it back, and /btw starts empty.
			await reload(page, view);
			await expect(view.getByTestId("side-panel")).toHaveCount(0);
			const again = await openPane(page, view);
			await expect(again.getByTestId("side-empty")).toBeVisible();
			await expect(again).not.toContainText(QUESTION);
		});

		test("a reload keeps the side conversation, finished or still running", async ({
			page,
			context,
		}) => {
			const { id, view } = await openSideChat(page, context, agent);
			const pane = await openPane(page, view);
			await ask(pane, QUESTION);
			await expect(pane).toContainText(ANSWER);
			await reload(page, view);
			const back = view.getByTestId("side-panel");
			await expect(back).toBeVisible();
			await expect(back.getByRole("heading", { name: `Side: ${name}` })).toBeVisible();
			await expect(back).toContainText(QUESTION);
			await expect(back).toContainText(ANSWER);
			await expect(back.getByTestId("side-composer")).toBeEnabled();
			// The replay is not a new question, and the main transcript still holds none of it.
			expect(await sideFrames(id)).toEqual([{ type: "side.ask", text: QUESTION }]);
			await expect(view.getByTestId("chat-scroll")).not.toContainText("Side answer");

			// A question still running when the page reloads is still running after it.
			await configureSide(id, { delayMs: NEVER });
			await ask(back, "Still working?");
			await expect(back.getByTestId("side-stop")).toBeVisible();
			await reload(page, view);
			const running = view.getByTestId("side-panel");
			await expect(running).toContainText("Still working?");
			await expect(running.getByTestId("side-stop")).toBeVisible();
			await expect(running.getByTestId("side-composer")).toBeDisabled();
			await running.getByTestId("side-stop").click();
			await expect(running.getByTestId("side-composer")).toBeEnabled();
		});

		test("a host that does not list btw offers no /btw and the browser sends no side frame", async ({
			page,
			context,
		}) => {
			const { id, view } = await openSideChat(page, context, agent, {
				offered: false,
			});
			const box = view.getByTestId("chat-composer-input");
			await box.click();
			await page.keyboard.type("/");
			await expect(view.getByRole("listbox", { name: "Commands" })).toBeVisible();
			await expect(view.getByRole("option", { name: /\/btw/ })).toHaveCount(0);
			await page.keyboard.type("btw");
			await expect(view.getByRole("option", { name: /\/btw/ })).toHaveCount(0);
			// Typed in full and sent, it is a plain message: no pane, no side frame.
			await page.keyboard.type(" a question");
			await page.keyboard.press("Enter");
			await expect.poll(async () => (await receivedFrames(id, "send")).length).toBe(1);
			await expect(view.getByTestId("side-panel")).toHaveCount(0);
			expect(await sideFrames(id)).toEqual([]);
			// It is offered the moment the host lists it, and not before.
			await configureSide(id, { offered: true });
			await box.click();
			await page.keyboard.type("/btw");
			await expect(view.getByRole("option", { name: /\/btw/ })).toBeVisible();
		});

		test("the pane works by keyboard alone and its controls have visible names", async ({
			page,
			context,
		}) => {
			const { id, view } = await openSideChat(page, context, agent, {
				delayMs: NEVER,
			});
			// Open it with the keyboard: the box takes the focus.
			const pane = await openPane(page, view);
			const box = pane.getByRole("textbox", { name: "Side question" });
			await expect(box).toBeFocused();
			await page.keyboard.type(QUESTION);
			await page.keyboard.press("Enter");
			// While the question runs, the keyboard waits on Stop rather than falling away.
			const stop = pane.getByRole("button", { name: "Stop the side question" });
			await expect(stop).toBeVisible();
			await expect(stop).toBeFocused();
			await expect(
				pane.getByRole("button", { name: "Ask", exact: true }),
			).toBeVisible();
			await expect(
				pane.getByRole("button", { name: "Close the side conversation" }),
			).toBeVisible();
			// Stop by keyboard; the box takes the focus back.
			await page.keyboard.press("Enter");
			await expect(box).toBeEnabled();
			await expect(box).toBeFocused();
			// Every control can be reached with the Tab key alone.
			const ask = pane.getByRole("button", { name: "Ask", exact: true });
			const close = pane.getByRole("button", { name: "Close the side conversation" });
			await tabTo(page, ask, "Tab");
			await tabTo(page, box, "Shift+Tab");
			await tabTo(page, close, "Shift+Tab");
			// Close by keyboard; the main box has the keyboard.
			await page.keyboard.press("Enter");
			await expect(view.getByTestId("side-panel")).toHaveCount(0);
			await expect(view.getByTestId("chat-composer-input")).toBeFocused();
			expect((await sideFrames(id)).map((f) => f.type)).toEqual([
				"side.ask",
				"side.stop",
				"side.end",
			]);
		});

		test("a dropped socket comes back with the pane open, its draft and the keyboard kept", async ({
			page,
			context,
		}) => {
			// Pass the chat socket through, so the test can drop the page's end of it.
			const sockets: WebSocketRoute[] = [];
			// Set to lose the page's side questions on the way to the host.
			let loseAsks = false;
			await page.routeWebSocket(/\/chat$/, (ws) => {
				const server = ws.connectToServer();
				ws.onMessage((message) => {
					if (!(loseAsks && String(message).includes('"side.ask"')))
						server.send(message);
				});
				sockets.push(ws);
			});
			const { id, view } = await openSideChat(page, context, agent);
			const pane = await openPane(page, view);
			await ask(pane, QUESTION);
			await expect(pane).toContainText(ANSWER);
			const box = pane.getByTestId("side-composer");
			await box.fill("A draft of the next one");
			await expect(box).toBeFocused();
			const before = sockets.length;
			await sockets.at(-1)?.close();
			await expect(view.getByTestId("chat-connection")).toHaveText("Reconnecting…");
			await expect.poll(() => sockets.length).toBeGreaterThan(before);
			await expect(view.getByTestId("chat-connection")).toHaveText("");
			// The host replays the conversation; the pane, its draft and the focus stay.
			await expect(view.getByTestId("side-panel")).toBeVisible();
			await expect(pane).toContainText(ANSWER);
			await expect(box).toHaveValue("A draft of the next one");
			await expect(box).toBeFocused();
			expect(await sideFrames(id)).toEqual([{ type: "side.ask", text: QUESTION }]);
			// A question lost with the dropped socket does not lock the pane.
			loseAsks = true;
			await ask(pane, "Lost on the way?");
			await expect(pane.getByTestId("side-stop")).toBeVisible();
			const lost = sockets.length;
			await sockets.at(-1)?.close();
			await expect.poll(() => sockets.length).toBeGreaterThan(lost);
			await expect(view.getByTestId("chat-connection")).toHaveText("");
			await expect(box).toBeEnabled();
			await expect(pane.getByTestId("side-stop")).toHaveCount(0);
		});

		test("a narrow chat puts the pane under it, readable and without violations", async ({
			page,
			context,
		}) => {
			await page.setViewportSize({ width: 600, height: 900 });
			const { id, view } = await openSideChat(page, context, agent);
			const pane = await openPane(page, view);
			await ask(pane, QUESTION);
			const answer = pane.getByText(ANSWER);
			await expect(answer).toBeVisible();
			await expect(answer).toBeInViewport();
			// Under the chat, not beside it.
			const chat = await view.getByTestId("chat-scroll").boundingBox();
			const side = await pane.boundingBox();
			expect(side && chat ? side.y >= chat.y + chat.height - 1 : false).toBe(true);
			await inBothThemes(page, async () => {
				await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);
			});
		});

		test("the divider resizes the pane with the arrow keys", async ({
			page,
			context,
		}) => {
			const { view } = await openSideChat(page, context, agent);
			const pane = await openPane(page, view);
			const handle = view.getByRole("separator", {
				name: "Resize the side conversation",
			});
			const width = async () => (await pane.boundingBox())?.width ?? 0;
			const before = await width();
			await handle.focus();
			for (let presses = 0; presses < 3; presses += 1)
				await page.keyboard.press("ArrowLeft");
			await expect.poll(width).toBeGreaterThan(before + 10);
			const wider = await width();
			for (let presses = 0; presses < 3; presses += 1)
				await page.keyboard.press("ArrowRight");
			await expect.poll(width).toBeLessThan(wider - 10);
		});

		test("a refused side question is answered in the pane, and the main transcript gains nothing", async ({
			page,
			context,
		}) => {
			const { id, view } = await openSideChat(page, context, agent);
			// The host lists btw, but its agent cannot answer: it refuses, as the host does.
			await configureSide(id, { answers: false });
			const pane = await openPane(page, view);
			await ask(pane, QUESTION);
			await expect(pane).toContainText("This chat cannot take side questions.");
			const box = pane.getByTestId("side-composer");
			await expect(box).toBeEnabled();
			await expect(pane.getByTestId("side-stop")).toHaveCount(0);
			const main = view.getByTestId("chat-scroll");
			await expect(main).not.toContainText("cannot take side questions");
			await expect(main).not.toContainText(QUESTION);
			// It can be asked again once the agent answers.
			await configureSide(id, { answers: true });
			await ask(pane, QUESTION);
			await expect(pane).toContainText(ANSWER);
		});

		test("/btw with a file attached is refused, since side questions are text only", async ({
			page,
			context,
		}) => {
			const { id, view } = await openSideChat(page, context, agent);
			await view.getByTestId("chat-composer-file").setInputFiles({
				name: "notes.txt",
				mimeType: "text/plain",
				buffer: Buffer.from("notes"),
			});
			await expect(view.getByTestId("composer-chip")).toBeVisible();
			await view.getByTestId("chat-composer-input").click();
			await page.keyboard.type(`/btw ${QUESTION}`);
			await page.keyboard.press("Escape");
			await page.keyboard.press("Enter");
			await expect(view.getByTestId("chat-composer-error")).toHaveText(
				"Side questions are text only. Remove the attached files, then ask again.",
			);
			await expect(view.getByTestId("side-panel")).toHaveCount(0);
			await expect(view.getByTestId("composer-chip")).toBeVisible();
			expect(await sideFrames(id)).toEqual([]);
			expect(await receivedFrames(id, "send")).toEqual([]);
		});

		test("the open pane has no accessibility violations in dark and light", async ({
			page,
			context,
		}) => {
			const { id, view } = await openSideChat(page, context, agent);
			await mainTurn(id, "start");
			const pane = await openPane(page, view);
			await ask(pane, QUESTION);
			await expect(pane).toContainText(ANSWER);
			await inBothThemes(page, async () => {
				await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);
			});
			// And while a question runs, with Stop showing and the box disabled.
			await configureSide(id, { delayMs: NEVER });
			await ask(pane, "Another one?");
			await expect(pane.getByTestId("side-stop")).toBeVisible();
			await inBothThemes(page, async () => {
				await expectNoViolations(page, `[data-testid="side-panel"]`);
			});
		});
	});
}

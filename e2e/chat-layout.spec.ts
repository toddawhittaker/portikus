import {
	expect,
	type Locator,
	type Page,
	test,
	type WebSocketRoute,
} from "@playwright/test";
import { makeChatTab } from "./chat-helpers";
import { terminalIds, workTabs } from "./helpers";
import { splitPane } from "./split-helpers";

/**
 * The chat holds to its pane (SPEC.md §8.1, §10.8): the app shell never
 * scrolls, only the conversation does, and the composer stays at the
 * pane's bottom edge whatever the cards do. The socket is scripted so a
 * tall question card and a stopped turn arrive when the test says.
 */

const LONG =
	"This option keeps the current structure and moves the slow query behind a cache, so the first load stays the same and later loads are faster. ";

const TALL_CARD = {
	id: "q-tall",
	questions: [1, 2, 3, 4].map((n) => ({
		question: `Question ${n}: ${LONG}Which way should the dashboard go?`,
		header: `Part ${n}`,
		multiSelect: n % 2 === 0,
		options: [1, 2, 3, 4].map((o) => ({
			label: `Option ${n}.${o}`,
			description: LONG.repeat(2),
			preview: Array.from(
				{ length: 14 },
				(_, line) => `line ${line} of ${n}.${o}`,
			).join("\n"),
		})),
	})),
};

interface Script {
	send: (type: string, body?: Record<string, unknown>) => void;
	answers: unknown[];
}

function script(ws: WebSocketRoute, into: Script, cards: unknown[]) {
	let seq = 0;
	const session = "00000000-0000-4000-8000-000000000000";
	into.send = (type, body = {}) =>
		ws.send(JSON.stringify({ type, sessionId: session, seq: seq++, ...body }));
	into.send("snapshot", { cards, turnRunning: false, truncated: false });
	const at = Date.now() - 60_000;
	for (let turn = 0; turn < 8; turn += 1) {
		into.send("message", {
			id: `u${turn}`,
			role: "user",
			markdown: `Question ${turn}`,
		});
		into.send("turn.started", { at: at + turn * 1000 });
		into.send("message", {
			id: `a${turn}`,
			role: "assistant",
			markdown: LONG.repeat(4),
		});
		into.send("turn.finished", { at: at + turn * 1000 + 500, status: "done" });
	}
	into.send("settings", {
		agent: "claude",
		model: "default",
		effort: "high",
		mode: "default",
	});
	ws.onMessage((raw) => {
		const message = JSON.parse(String(raw));
		into.answers.push(message);
		if (message.type === "question.answer")
			into.send("card.resolved", { id: message.id });
	});
}

async function openChat(
	page: Page,
	context: Parameters<typeof makeChatTab>[1],
	cards: unknown[] = [],
) {
	const made = await makeChatTab(page, context);
	const socket: Script = { send: () => undefined, answers: [] };
	await page.routeWebSocket(/\/chat$/, (ws) => script(ws, socket, cards));
	await page.reload();
	const view = page.getByTestId(`chat-view-${made.id}`);
	await expect(view.getByText("Question 7", { exact: true })).toBeVisible({
		timeout: 15_000,
	});
	return { ...made, view, socket };
}

/** How the pane and everything around it sit; every number should be 0. */
function measure(page: Page, terminalId: string) {
	return page.evaluate((id) => {
		const pane = document.querySelector<HTMLElement>(
			`[data-testid="terminal-leaf-${id}"]`,
		);
		const chat = pane?.querySelector<HTMLElement>(".pk-chat");
		const composer = pane?.querySelector<HTMLElement>(".pk-chat-composer");
		if (!pane || !chat || !composer) throw new Error("no chat pane");
		const box = pane.getBoundingClientRect();
		const scrolled: string[] = [];
		for (let node: HTMLElement | null = pane; node; node = node.parentElement) {
			if (node.scrollTop !== 0 || node.scrollLeft !== 0) {
				scrolled.push(`${node.tagName}.${node.className}`);
			}
		}
		return {
			pageScroll: Math.abs(window.scrollX) + Math.abs(window.scrollY),
			scrolled,
			paneOverflow: pane.scrollHeight - pane.clientHeight,
			chatOverflow: chat.scrollHeight - chat.clientHeight,
			// The pane has no border, so its content box ends at its rectangle's bottom.
			composerGap: Math.round(
				box.top +
					pane.clientTop +
					pane.clientHeight -
					composer.getBoundingClientRect().bottom,
			),
		};
	}, terminalId);
}

async function expectHeld(page: Page, terminalId: string) {
	expect(await measure(page, terminalId)).toEqual({
		pageScroll: 0,
		scrolled: [],
		paneOverflow: 0,
		chatOverflow: 0,
		composerGap: 0,
	});
	const tabs = await workTabs(page).boundingBox();
	expect(tabs?.y ?? -1).toBeGreaterThanOrEqual(0);
	expect(tabs?.x ?? -1).toBeGreaterThanOrEqual(0);
}

/** Answer the tall card by keyboard only, a question at a time. */
async function answerByKeyboard(page: Page, view: Locator, terminalId: string) {
	const card = view.getByTestId("chat-question-card");
	await card.getByRole("radio").first().focus();
	for (let n = 1; n <= 4; n += 1) {
		await expect(card.getByTestId("chat-question-position")).toHaveText(`${n} of 4`);
		if (n % 2 === 0) await page.keyboard.press("Space");
		else await page.keyboard.press("ArrowDown");
		await expectHeld(page, terminalId);
		await page.keyboard.press("Control+Enter");
	}
	await expect(card).toHaveCount(0);
}

/** The log sits at its end, with no "Jump to latest" offered. */
async function expectLogAtEnd(view: Locator) {
	await expect
		.poll(() =>
			view
				.getByTestId("chat-scroll")
				.evaluate((box) =>
					Math.round(box.scrollHeight - box.scrollTop - box.clientHeight),
				),
		)
		.toBeLessThanOrEqual(1);
	await expect(view.getByTestId("chat-jump")).toHaveCount(0);
}

/** The card's buttons and the message box are in view, inside the pane. */
async function expectControlsInView(page: Page, view: Locator, terminalId: string) {
	const pane = await page.getByTestId(`terminal-leaf-${terminalId}`).boundingBox();
	if (!pane) throw new Error("no pane");
	for (const control of [
		view.getByTestId("chat-question-next"),
		view.getByTestId("chat-question-skip"),
		view.getByTestId("chat-composer-input"),
	]) {
		const box = await control.boundingBox();
		expect(box?.y ?? -1).toBeGreaterThanOrEqual(pane.y);
		expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
			pane.y + pane.height,
		);
	}
	// Nothing in the card's body is drawn over its buttons.
	const body = await view.locator(".pk-chat-qbody").boundingBox();
	const foot = await view.locator(".pk-chat-qfoot").boundingBox();
	expect((body?.y ?? 0) + (body?.height ?? 0)).toBeLessThanOrEqual((foot?.y ?? 0) + 1);
}

for (const size of [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 720 },
	{ width: 800, height: 900 },
] as const) {
	test(`a tall question card never scrolls the page or the pane (${size.width}x${size.height})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await page.setViewportSize(size);
		const { id, view, socket } = await openChat(page, context);
		await expectHeld(page, id);

		socket.send("question.requested", TALL_CARD);
		await expect(view.getByTestId("chat-question-card")).toBeVisible();
		await expectHeld(page, id);
		await expectLogAtEnd(view);
		await expectControlsInView(page, view, id);
		await answerByKeyboard(page, view, id);
		await expectHeld(page, id);
		expect(socket.answers).toHaveLength(1);

		// A turn stopped part way leaves the pane as it was.
		socket.send("turn.started", { at: Date.now() });
		socket.send("message", { id: "a-stop", role: "assistant", markdown: LONG });
		socket.send("turn.finished", { at: Date.now(), status: "interrupted" });
		await expect(view.getByTestId("chat-announcer")).toHaveText("Claude stopped.");
		await expectHeld(page, id);

		// The session's rules, open, sit above the message box without moving it.
		socket.send("rules", {
			rules: [{ rule: "Bash(sed:*)", description: '"sed" commands in this session' }],
		});
		const rules = view.getByTestId("chat-session-rules");
		await rules.locator("> summary").click();
		await expect(rules.getByTestId("chat-session-rule")).toBeVisible();
		await expectHeld(page, id);
		const listed = await rules.boundingBox();
		const composer = await view.locator(".pk-chat-composer").boundingBox();
		expect((listed?.y ?? 0) + (listed?.height ?? 0)).toBeLessThanOrEqual(
			composer?.y ?? 0,
		);
	});
}

test("in a split pane the chat keeps one scrollbar and its composer at the bottom", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	const { id, view, socket, student, project } = await openChat(page, context);
	await splitPane(page, id, "right");
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(2);
	await expectHeld(page, id);

	socket.send("question.requested", TALL_CARD);
	await expect(view.getByTestId("chat-question-card")).toBeVisible();
	await expectHeld(page, id);
	await answerByKeyboard(page, view, id);
	await expectHeld(page, id);

	socket.send("turn.started", { at: Date.now() });
	socket.send("turn.finished", { at: Date.now(), status: "interrupted" });
	await expect(view.getByTestId("chat-announcer")).toHaveText("Claude stopped.");
	await expectHeld(page, id);
});

test("a chat opened with a card waiting lands at the end of its log", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	const { id, view } = await openChat(page, context, [
		{ type: "question", ...TALL_CARD },
	]);
	await expect(view.getByTestId("chat-question-card")).toBeVisible();
	await expectLogAtEnd(view);
	await expectHeld(page, id);
	await expectControlsInView(page, view, id);
});

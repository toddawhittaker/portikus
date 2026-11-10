import {
	expect,
	type Locator,
	type Page,
	test,
	type WebSocketRoute,
} from "@playwright/test";
import { makeChatTab, scriptedChat } from "./chat-helpers";
import { expectNoViolations, terminalIds, workTabs } from "./helpers";
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
	into.send = scriptedChat(ws, "00000000-0000-4000-8000-000000000000");
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

/** A running turn's tool calls: two finished, one failed, one still running. */
function sendTools(socket: Script) {
	socket.send("turn.started", { at: Date.now() });
	socket.send("tool.started", {
		id: "read",
		name: "Read",
		title: "Read a file",
		input: { file_path: "src/dashboard/useDashboardQuery.ts" },
	});
	socket.send("tool.output", { id: "read", part: { type: "text", text: "export {}" } });
	socket.send("tool.finished", { id: "read", isError: false });
	socket.send("tool.started", {
		id: "edit",
		name: "Edit",
		title: "Edit a file",
		input: {
			file_path: "src/dashboard/useDashboardQuery.ts",
			old_string: "const a = 1;\nconst b = 2;\nreturn a ?? b;",
			new_string: "return 1;",
		},
	});
	socket.send("tool.finished", { id: "edit", isError: false });
	socket.send("tool.started", {
		id: "lint",
		name: "Bash",
		title: "Lint",
		input: { command: "pnpm lint" },
	});
	socket.send("tool.output", { id: "lint", part: { type: "text", text: "1 error" } });
	socket.send("tool.finished", { id: "lint", isError: true });
	socket.send("tool.started", {
		id: "test",
		name: "Bash",
		title: "Test",
		input: { command: "pnpm vitest run" },
	});
}

for (const colorScheme of ["light", "dark"] as const) {
	for (const width of [1280, 420] as const) {
		test(`tool calls are quiet lines that say what happened (${colorScheme}, ${width})`, async ({
			page,
			context,
		}) => {
			test.setTimeout(90_000);
			await page.emulateMedia({ colorScheme });
			await page.setViewportSize({ width, height: 900 });
			const { id, view, socket } = await openChat(page, context);
			sendTools(socket);
			const summary = (id: string) =>
				view.getByTestId(`chat-tool-${id}`).locator("> summary");
			// The four calls in a row share one group; its rows show once it opens.
			await view.getByTestId("chat-tool-group").locator("> summary").click();
			await expect(summary("read")).toHaveText("Read useDashboardQuery.ts");
			await expect(summary("edit")).toHaveText(
				"Edited useDashboardQuery.ts+1 −3, 1 line added, 3 lines removed",
			);
			await expect(summary("lint")).toHaveText("Run pnpm lintFailed");
			await expect(summary("test")).toHaveText("Running pnpm vitest run");
			// Only the failed and the running call carry a state; "Running" is said once.
			await expect(view.getByTestId("chat-tool-state")).toHaveText(["Failed", ""]);
			// No box around a row.
			await expect(view.getByTestId("chat-tool-read")).toHaveCSS(
				"border-top-width",
				"0px",
			);

			// Opened, an edit shows its path and diff, and no "No output".
			await summary("edit").click();
			const edit = view.getByTestId("chat-tool-edit");
			await expect(edit.locator(".pk-chat-tool-path")).toHaveText(
				"src/dashboard/useDashboardQuery.ts",
			);
			await expect(edit.getByTestId("chat-diff")).toBeVisible();
			await expect(edit).not.toContainText("No output");
			// A one-line command is not repeated under the row.
			await summary("lint").click();
			const lint = view.getByTestId("chat-tool-lint");
			await expect(lint.getByRole("region", { name: "Error" })).toContainText(
				"1 error",
			);
			await expect(lint.locator(".pk-chat-command")).toHaveCount(0);
			await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);

			// The row is reached and opened from the keyboard.
			await summary("read").focus();
			await page.keyboard.press("Enter");
			await expect(view.getByTestId("chat-tool-read")).toHaveAttribute("open", "");
			socket.send("tool.finished", { id: "test", isError: false });
			await expect(summary("test")).toHaveText("Ran pnpm vitest run");
		});
	}
}

for (const colorScheme of ["light", "dark"] as const) {
	for (const width of [1280, 420] as const) {
		test(`a run of tool calls is one disclosure that shows progress and folds when the turn ends (${colorScheme}, ${width})`, async ({
			page,
			context,
		}) => {
			test.setTimeout(90_000);
			await page.emulateMedia({ colorScheme });
			await page.setViewportSize({ width, height: 900 });
			const { id, view, socket } = await openChat(page, context);
			socket.send("message", { id: "go", role: "user", markdown: "Fix the lint" });
			sendTools(socket);
			const turn = view.getByTestId("chat-turn").last();
			const group = turn.getByTestId("chat-tool-group");
			const head = group.locator("> summary");
			await expect(group).toHaveCount(1);
			await expect(head).toHaveText("4 tool callsRunning pnpm vitest run1 failed");
			await expect(group).toHaveAttribute("data-status", "running");
			// Closed, its rows are hidden; one byline heads the whole turn.
			await expect(view.getByTestId("chat-tool-read")).toBeHidden();
			await expect(turn.locator(".pk-chat-author")).toHaveCount(1);
			// The polite announcement says Claude is working, not each call.
			await expect(view.getByTestId("chat-announcer")).toHaveText("Claude is working.");
			await expectLogAtEnd(view);
			await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);

			// From the keyboard the group opens, then a row inside it.
			await head.focus();
			await page.keyboard.press("Enter");
			await expect(group).toHaveAttribute("open", "");
			const row = view.getByTestId("chat-tool-read").locator("> summary");
			await row.focus();
			await page.keyboard.press("Enter");
			await expect(view.getByTestId("chat-tool-read")).toHaveAttribute("open", "");
			await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);

			// A new call joins the group, and the log still follows it.
			socket.send("tool.finished", { id: "test", isError: false });
			socket.send("tool.started", {
				id: "build",
				name: "Bash",
				title: "Build",
				input: { command: "pnpm build" },
			});
			await expect(head).toHaveText("5 tool callsRunning pnpm build1 failed");
			await expectLogAtEnd(view);
			await expect(view.getByTestId("chat-announcer")).toHaveText("Claude is working.");

			// Text breaks the run; the turn's end folds it all into "Worked for".
			socket.send("tool.finished", { id: "build", isError: false });
			socket.send("message", { id: "said", role: "assistant", markdown: "All fixed." });
			socket.send("turn.finished", { at: Date.now(), status: "done" });
			const worked = turn.getByTestId("chat-worked");
			await expect(worked.locator("> summary")).toContainText("5 tool calls");
			await worked.locator("> summary").click();
			await expect(worked.getByTestId("chat-tool-group")).toHaveCount(1);
			await expect(worked.getByTestId("chat-tool-group-what")).toHaveText(
				"Read, Edit, Bash",
			);
			await expect(turn.locator(".pk-chat-author")).toHaveCount(1);
		});
	}
}

test("a lone row the student opened stays open and keeps the keyboard when a second call joins it", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1280, height: 900 });
	const { id, view, socket } = await openChat(page, context);
	socket.send("turn.started", { at: Date.now() });
	socket.send("tool.started", {
		id: "one",
		name: "Bash",
		title: "Test",
		input: { command: "pnpm test" },
	});
	socket.send("tool.output", { id: "one", part: { type: "text", text: "12 passed" } });
	const row = view.getByTestId("chat-tool-one");
	await row.locator("> summary").focus();
	await page.keyboard.press("Enter");
	await expect(row).toHaveAttribute("open", "");
	socket.send("tool.finished", { id: "one", isError: false });
	socket.send("tool.started", {
		id: "two",
		name: "Bash",
		title: "Lint",
		input: { command: "pnpm lint" },
	});
	const group = view.getByTestId("chat-tool-group");
	await expect(group.locator("> summary")).toHaveText("2 tool callsRunning pnpm lint");
	await expect(group.locator("> summary")).toBeFocused();
	await expect(group).toHaveAttribute("open", "");
	await expect(row.getByText("12 passed")).toBeVisible();
	await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);
});

test("Claude's history outside a turn has one byline per run of its work", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1280, height: 900 });
	const { view, socket } = await openChat(page, context);
	const before = await view.getByTestId("chat-turn").count();
	// As a reloaded history arrives: no turn around Claude's messages and calls.
	socket.send("message", { id: "h-u", role: "user", markdown: "Old question" });
	socket.send("message", { id: "h-a", role: "assistant", markdown: "Looking now." });
	for (const one of ["h-1", "h-2", "h-3"]) {
		socket.send("tool.started", {
			id: one,
			name: "Bash",
			title: one,
			input: { command: `echo ${one}` },
		});
		socket.send("tool.finished", { id: one, isError: false });
	}
	socket.send("message", { id: "h-b", role: "assistant", markdown: "Found it." });
	await expect(view.getByText("Found it.")).toBeVisible();
	await expect(view.getByTestId("chat-turn")).toHaveCount(before + 1);
	const last = view.getByTestId("chat-turn").last();
	await expect(last.locator(".pk-chat-author")).toHaveCount(1);
	await expect(last.getByTestId("chat-tool-group").locator("> summary")).toHaveText(
		"3 tool callsBash",
	);
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`Jump to latest never covers the last message (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme });
		await page.setViewportSize({ width: 800, height: 720 });
		const { id, view, socket } = await openChat(page, context);
		socket.send("message", { id: "end", role: "user", markdown: LONG.repeat(3) });
		await expectLogAtEnd(view);
		const log = view.getByTestId("chat-scroll");
		// Scrolled back just past the end, as when reading the last reply again.
		await log.evaluate((box) => box.scrollBy(0, -80));
		const jump = view.getByRole("button", { name: "Jump to latest" });
		await expect(jump).toBeVisible();
		const area = await log.boundingBox();
		const button = await jump.boundingBox();
		const bubble = await view
			.getByTestId("chat-user-message")
			.last()
			.locator(".pk-chat-bubble")
			.boundingBox();
		if (!area || !button || !bubble) throw new Error("no log, button or bubble");
		// The button sits below the log, so nothing scrolled in the log is beneath it.
		expect(button.y).toBeGreaterThanOrEqual(area.y + area.height - 1);
		const visibleBottom = Math.min(bubble.y + bubble.height, area.y + area.height);
		expect(button.y).toBeGreaterThanOrEqual(visibleBottom - 1);
		await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);
	});
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`Jump to latest is a round button at the bottom right, with a dot for news (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme });
		await page.setViewportSize({ width: 1280, height: 720 });
		const { id, view, socket } = await openChat(page, context);
		const log = view.getByTestId("chat-scroll");
		await log.evaluate((box) => box.scrollTo(0, 0));
		const jump = view.getByRole("button", { name: "Jump to latest" });
		await expect(jump).toBeVisible();
		await expect(jump).not.toHaveAttribute("data-fresh");
		await expect(view.locator(".pk-chat-jump-dot")).toHaveCount(0);

		// Round, at the right, just below the log rather than over it.
		const radius = await jump.evaluate((node) => getComputedStyle(node).borderRadius);
		expect(Number.parseFloat(radius)).toBeGreaterThan(100);
		const area = await log.boundingBox();
		const button = await jump.boundingBox();
		if (!area || !button) throw new Error("no log or button");
		expect(button.x).toBeGreaterThan(area.x + area.width * 0.75);
		expect(button.y).toBeGreaterThanOrEqual(area.y + area.height - 1);

		// Something new while reading back: a dot, and a description for a screen reader.
		socket.send("message", { id: "late", role: "user", markdown: "Another question" });
		await expect(jump).toHaveAttribute("data-fresh", "true");
		await expect(view.locator(".pk-chat-jump-dot")).toBeVisible();
		await expect(jump).toHaveAccessibleDescription("Something new arrived below");
		await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);

		// The keyboard reaches it; Enter goes to the end and the dot goes with the button.
		await jump.focus();
		await page.keyboard.press("Enter");
		await expectLogAtEnd(view);
		await expect(view.getByTestId("chat-composer-input")).toBeFocused();

		// Scrolling back again starts with no dot.
		await log.evaluate((box) => box.scrollTo(0, 0));
		await expect(jump).toBeVisible();
		await expect(jump).not.toHaveAttribute("data-fresh");
	});
}

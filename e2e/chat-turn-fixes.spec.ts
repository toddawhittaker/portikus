import { expect, type Locator, test } from "@playwright/test";
import { type Frame, makeChatTab, scriptChat } from "./chat-helpers";

/**
 * A running turn as the student sees it (SPEC.md §10.8, §25.8): the Working
 * line says when a step waits for permission, what Claude asked shows its
 * answer once, the Jump to latest button leaves the end of the conversation
 * readable, and the composer stays whole on a short window.
 */

const BASH = { command: "pnpm test --filter web" };

/** A turn whose Bash call waits on its permission card. */
const ASKING: Frame[] = [
	["message", { id: "u1", role: "user", markdown: "Run the web tests" }],
	["turn.started", { at: Date.now() - 5_000 }],
	["tool.started", { id: "p1", name: "Bash", title: "pnpm test", input: BASH }],
	[
		"permission.requested",
		{
			id: "p1",
			toolName: "Bash",
			title: "pnpm test",
			input: BASH,
			options: [
				{ id: "allow", label: "Allow once" },
				{ id: "deny", label: "Deny" },
			],
		},
	],
];

async function box(locator: Locator) {
	const found = await locator.boundingBox();
	if (!found) throw new Error("the element is not shown");
	return found;
}

test("the Working line says Waiting for your permission until the card is answered", async ({
	page,
	context,
}) => {
	test.setTimeout(60_000);
	const { id } = await makeChatTab(page, context);
	const view = await scriptChat(page, id, {
		first: ASKING,
		reply: (message, send) => {
			if (message.type === "permission.answer") send(["card.resolved", { id: "p1" }]);
		},
	});
	const working = view.getByTestId("chat-working");
	await expect(working).toHaveText(/^Waiting for your permission · \d+m \d+s$/);
	await view
		.getByTestId("chat-permission-card")
		.getByRole("button", { name: "Allow once", exact: true })
		.click();
	await expect(working).toHaveText(/^Running pnpm test --filter web · \d+m \d+s$/);
	// The row says it in the same words, once.
	await expect(view.getByTestId("chat-tool-p1").locator("> summary")).toHaveText(
		"Running pnpm test --filter web",
	);
});

test("an answer in a form not read is shown once, under all the questions", async ({
	page,
	context,
}) => {
	test.setTimeout(60_000);
	const { id } = await makeChatTab(page, context);
	const view = await scriptChat(page, id, {
		first: [
			["message", { id: "u1", role: "user", markdown: "Ask me" }],
			["turn.started", { at: Date.now() - 5_000 }],
			[
				"tool.started",
				{
					id: "q1",
					name: "AskUserQuestion",
					title: "AskUserQuestion",
					input: { questions: [{ question: "Which?" }, { question: "Why?" }] },
				},
			],
			[
				"tool.output",
				{ id: "q1", part: { type: "text", text: "Picked B, for speed." } },
			],
			["tool.finished", { id: "q1", isError: false }],
			["turn.finished", { at: Date.now(), status: "done" }],
		],
	});
	const asked = view.getByTestId("chat-asked");
	await asked.locator("summary").click();
	await expect(asked.getByRole("term")).toHaveText(["Which?", "Why?"]);
	await expect(asked.getByRole("definition")).toHaveText(["Picked B, for speed."]);
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`at 420 px, Jump to latest never covers the sent-while-working note (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(60_000);
		await page.emulateMedia({ colorScheme });
		await page.setViewportSize({ width: 420, height: 800 });
		const { id } = await makeChatTab(page, context);
		const history: Frame[] = [];
		for (let turn = 0; turn < 6; turn += 1) {
			history.push(
				["message", { id: `u${turn}`, role: "user", markdown: `Question ${turn}` }],
				["turn.started", { at: Date.now() - 60_000 }],
				[
					"message",
					{
						id: `a${turn}`,
						role: "assistant",
						markdown: `A long answer ${turn}. `.repeat(12),
					},
				],
				["turn.finished", { at: Date.now() - 50_000, status: "done" }],
			);
		}
		const view = await scriptChat(page, id, {
			first: [
				...history,
				["message", { id: "u9", role: "user", markdown: "Run the web tests" }],
				["turn.started", { at: Date.now() - 5_000 }],
				["tool.started", { id: "t1", name: "Bash", title: "pnpm test", input: BASH }],
			],
			reply: (message, send) => {
				const { text } = message as { text?: string };
				if (message.type === "send") {
					send(["message", { id: "u10", role: "user", markdown: text ?? "" }]);
				}
			},
		});
		const composer = view.getByTestId("chat-composer-input");
		await composer.fill("Skip the docs");
		await composer.press("Enter");
		const note = view.getByTestId("chat-sent-while-working");
		await expect(note).toBeVisible();
		const scroll = view.getByTestId("chat-scroll");
		const jump = view.getByTestId("chat-jump");
		// At the end there is no button over the note.
		await expect(jump).toHaveCount(0);
		await expect(note).toBeInViewport();
		// Scrolled back far enough for the button, the note is never under it.
		for (const back of [49, 60, 80, 100, 140]) {
			await scroll.evaluate((node, by) => {
				node.scrollTop = node.scrollHeight - node.clientHeight - by;
			}, back);
			await expect(jump).toBeVisible();
			const button = await box(jump);
			const area = await box(scroll);
			const whole = await box(note);
			// Only the part of the note the log shows can be covered.
			const top = Math.max(whole.y, area.y);
			const bottom = Math.min(whole.y + whole.height, area.y + area.height);
			const shown = { ...whole, y: top, height: Math.max(0, bottom - top) };
			const covered =
				shown.height > 0 &&
				shown.y < button.y + button.height &&
				button.y < shown.y + shown.height &&
				shown.x < button.x + button.width &&
				button.x < shown.x + shown.width;
			expect(covered, `scrolled back ${back}px`).toBe(false);
		}
		await jump.click();
		await expect(jump).toHaveCount(0);
		await expect(note).toBeInViewport();
	});
}

for (const docked of [false, true]) {
	test(`at 800 by 720 px the whole composer shows above the status bar${docked ? ", with a card docked" : ""}`, async ({
		page,
		context,
	}) => {
		test.setTimeout(60_000);
		await page.setViewportSize({ width: 800, height: 720 });
		const { id } = await makeChatTab(page, context);
		const view = await scriptChat(page, id, { first: docked ? ASKING : [] });
		if (docked) await expect(view.getByTestId("chat-permission-card")).toBeVisible();
		await page.screenshot({
			path: `screenshots/f3-composer-800x720${docked ? "-card" : ""}.png`,
		});
		const bar = await box(page.getByTestId("status-bar"));
		const pane = await box(view);
		for (const part of [
			"chat-composer",
			"chat-composer-send",
			"composer-options",
			"chat-composer-hint",
		]) {
			const shown = await box(view.getByTestId(part));
			expect(shown.y + shown.height, part).toBeLessThanOrEqual(
				Math.min(bar.y, pane.y + pane.height),
			);
		}
		// Nothing lies over Send.
		const send = view.getByTestId("chat-composer-send");
		const hit = await send.evaluate((node) => {
			const rect = node.getBoundingClientRect();
			const top = document.elementFromPoint(
				rect.x + rect.width / 2,
				rect.y + rect.height / 2,
			);
			return top !== null && node.contains(top);
		});
		expect(hit).toBe(true);
	});
}

import { expect, type Page, test } from "@playwright/test";
import {
	answersOf,
	expectAnnounced,
	inBothThemes,
	openChat,
	openWork,
	rowLine,
	sendMessage,
} from "./chat-helpers";
import { createStudent, expectNoViolations } from "./helpers";

/**
 * The Codex chat on the fake host, and what both agents share (SPEC.md
 * §10.8, §25.8): rows in Claude's styles, one MCP row and card with the
 * declined-form notice, the agent's name in cards, and who may attach. The
 * fake host speaks both agents through the API relay.
 */

const SECRET = "tok-9f3a-never-shown";
const NOTICE =
	"A tool asked for input in a form the chat cannot show, so it was declined. Use a terminal tab for that tool.";

/** Run `check` in a 360 px window, both themes, then give the window back. */
async function atPhoneWidth(page: Page, check: () => Promise<void>) {
	const wide = page.viewportSize() ?? { width: 1280, height: 720 };
	await page.setViewportSize({ width: 360, height: 800 });
	await inBothThemes(page, check);
	await page.emulateMedia({ colorScheme: "dark" });
	await page.setViewportSize(wide);
}

/** The first Codex turn of the fake host, finished, with its cards open. */
async function codexTurn(page: Page, workspaceId: string, name: string) {
	const chat = await openChat(page, workspaceId, name, "codex");
	await sendMessage(chat.view, "Look at the project");
	await expect(chat.view.getByTestId("chat-permission-card")).toBeVisible({
		timeout: 15_000,
	});
	return chat;
}

test.describe("Codex's turn on the fake host", () => {
	test.describe.configure({ timeout: 120_000 });

	test("each item draws in Claude's row styles, and the agent is named Codex throughout", async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: "dark" });
		const student = await createStudent(context);
		const { view } = await openChat(page, student.workspaceId, "Codex rows", "codex");
		await expect(view.getByTestId("chat-composer-input")).toHaveAttribute(
			"aria-label",
			"Message Codex",
		);
		await sendMessage(view, "Look at the project");
		await expect(view.getByTestId("chat-permission-card")).toBeVisible({
			timeout: 15_000,
		});
		const turn = await openWork(view);
		await expect(turn.locator(".pk-chat-author")).toHaveText("Codex");

		const sentence: Record<string, string> = {
			"cx-1": "Read README.md",
			"cx-2": "Searched for answer in src",
			"cx-3": "Edited src/answer.ts",
			"cx-4": "Searched the web for codex app-server",
			"cx-5": "Viewed diagram.png",
			"cx-6": "Started a subagent",
			"cx-7": "Updated the plan",
			"cx-mcp": "Used search_issues · github",
			"cx-plan": "Proposed a plan",
		};
		for (const [id, text] of Object.entries(sentence)) {
			await expect(rowLine(view, id)).toContainText(text);
		}
		// An edit shows what it changed, and the turn counts its file.
		await expect(rowLine(view, "cx-3")).toContainText("+1 −1");
		await expect(turn.getByTestId("chat-files-changed")).toContainText(
			"1 file changed",
		);
		// Plan steps are a list that says each step's state in words.
		const steps = view.getByTestId("chat-tool-cx-7");
		await rowLine(view, "cx-7").click();
		await expect(steps.getByRole("listitem")).toHaveText([
			/Done\s*Read the failing test/,
			/In progress\s*Fix the answer/,
			/To do\s*Run the tests/,
		]);
		// An MCP server's request for a form is declined with a line, for either agent.
		await expect(turn.getByTestId("chat-error")).toHaveText(NOTICE);

		await expectNoViolations(page, '[data-testid="chat-scroll"]');
		await page.emulateMedia({ colorScheme: "light" });
		await expectNoViolations(page, '[data-testid="chat-scroll"]');

		// A 360 px window: the diff scrolls inside its own box, never the page.
		await page.setViewportSize({ width: 360, height: 800 });
		await rowLine(view, "cx-3").click();
		await expect(
			view.getByTestId("chat-tool-cx-3").getByRole("group").first(),
		).toBeVisible();
		await page.emulateMedia({ colorScheme: "dark" });
		await expectNoViolations(page, '[data-testid="chat-scroll"]');
		await page.emulateMedia({ colorScheme: "light" });
		await expectNoViolations(page, '[data-testid="chat-scroll"]');
		expect(
			await page.evaluate(
				() =>
					document.documentElement.scrollWidth - document.documentElement.clientWidth,
			),
		).toBeLessThanOrEqual(0);
	});

	test("cards: Allow for this chat, the plan card and its decision line, then the questions, read aloud as they appear", async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: "dark" });
		const student = await createStudent(context);
		const { id, view } = await codexTurn(page, student.workspaceId, "Codex cards");
		const card = view.getByTestId("chat-permission-card");

		// Approval card of an MCP tool: the heading, the announcement and the buttons.
		expect(await expectAnnounced(view, 2)).toBe("Allow github to run search_issues?");
		await expect(card.getByRole("button")).toHaveText([
			/Allow$/,
			/Allow for this chat/,
			/Deny/,
		]);
		await inBothThemes(page, () =>
			expectNoViolations(page, '[data-testid="chat-cards"]'),
		);
		await atPhoneWidth(page, () =>
			expectNoViolations(page, '[data-testid="chat-cards"]'),
		);
		await card.getByRole("button", { name: "Allow for this chat" }).click();

		// The plan card: its heading, the plan as text, and the same words announced.
		await expect(card.getByRole("heading", { level: 2 })).toHaveText(
			"Codex has a plan for you to review",
		);
		expect(await expectAnnounced(view, 1)).toBe("Codex has a plan for you to review");
		await expect(card.getByTestId("chat-plan")).toContainText("Fix the answer in");
		await expect(card.getByRole("button")).toHaveText([
			/Yes, in Auto/,
			/Yes, and ask first/,
			/No, keep planning/,
		]);
		await inBothThemes(page, () =>
			expectNoViolations(page, '[data-testid="chat-cards"]'),
		);
		await atPhoneWidth(page, () =>
			expectNoViolations(page, '[data-testid="chat-cards"]'),
		);
		await card.getByRole("button", { name: /Yes, in Auto/ }).click();

		// The questions: no options is a text field; the secret one is a password field.
		const questions = view.getByRole("region", { name: "Codex's questions" });
		await expect(questions).toBeVisible();
		await expect(view.getByTestId("chat-announcer")).toHaveText(
			"Codex has 2 questions.",
		);
		await expect(view.getByTestId("chat-question-position")).toHaveText("1 of 2");
		const answer = questions.getByTestId("chat-question-answer");
		await expect(answer).toHaveAttribute("type", "text");
		await expect(answer).toHaveAccessibleName("Which branch should I use?");
		await answer.fill("main");
		await inBothThemes(page, () =>
			expectNoViolations(page, '[data-testid="chat-cards"]'),
		);
		await page.emulateMedia({ colorScheme: "dark" });
		await questions.getByTestId("chat-question-next").click();

		await expect(view.getByTestId("chat-question-position")).toHaveText("2 of 2");
		const secret = questions.getByTestId("chat-question-answer");
		await expect(secret).toHaveAttribute("type", "password");
		await expect(secret).toHaveAttribute("autocomplete", "off");
		await expect(secret).toHaveAccessibleName("What is the deploy token?");
		await expect(secret).toHaveAccessibleDescription(
			"Hidden as you type. It goes to Codex and is not shown in the conversation.",
		);
		await secret.fill(SECRET);
		await inBothThemes(page, () =>
			expectNoViolations(page, '[data-testid="chat-cards"]'),
		);
		await page.emulateMedia({ colorScheme: "dark" });
		await questions.getByTestId("chat-question-next").click();
		await expect(view.getByTestId("chat-question-card")).toHaveCount(0);

		// The host got every answer by the button's id, and the secret only as an answer.
		await expect.poll(async () => (await answersOf(id)).length).toBe(3);
		const sent = await answersOf(id);
		expect(sent[0]).toMatchObject({ id: "cx-mcp", optionId: "session" });
		expect(sent[1]).toMatchObject({ id: "cx-plan", optionId: "implement-auto" });
		expect(sent[2]).toMatchObject({
			type: "question.answer",
			id: "cx-question",
			answers: {
				"Which branch should I use?": "main",
				"What is the deploy token?": SECRET,
			},
		});

		// Each decision is a line under its row. The secret is nowhere on the page.
		const turn = await openWork(view);
		await expect(turn.getByTestId("chat-decision")).toHaveText([
			"Allowed for this chat: search_issues · github",
			"Plan approved",
		]);
		await expect(view).not.toContainText(SECRET);
		expect(await page.content()).not.toContain(SECRET);
		await inBothThemes(page, () =>
			expectNoViolations(page, '[data-testid="chat-scroll"]'),
		);
	});

	test("Deny asks what to do instead, and No, keep planning ends in Kept planning", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { id, view } = await codexTurn(page, student.workspaceId, "Codex deny");
		const card = view.getByTestId("chat-permission-card");

		await card.getByRole("button", { name: "Deny" }).click();
		const reason = view.getByLabel("Tell Codex what to do instead");
		await expect(reason).toBeFocused();
		await reason.fill("Use the docs instead");
		await reason.press("Enter");
		await expect(card.getByRole("heading", { level: 2 })).toHaveText(
			"Codex has a plan for you to review",
		);

		await card.getByRole("button", { name: /No, keep planning/ }).click();
		await view.getByLabel("Tell Codex what to do instead").press("Enter");
		await expect(view.getByTestId("chat-question-card")).toBeVisible();

		await expect.poll(async () => (await answersOf(id)).length).toBe(2);
		const sent = await answersOf(id);
		expect(sent[0]).toMatchObject({
			id: "cx-mcp",
			optionId: "deny",
			message: "Use the docs instead",
		});
		expect(sent[1]).toMatchObject({ id: "cx-plan", optionId: "keep-planning" });
		const turn = await openWork(view);
		// The reason is for the agent; the line records only the decision.
		await expect(turn.getByTestId("chat-decision")).toHaveText([
			"Denied: search_issues · github",
			"Kept planning",
		]);
		await expect(view.getByText("Use the docs instead")).toHaveCount(0);
	});
});

/** The decision a card's button sends, from the fake chat's answers. */
async function lastAnswer(id: string) {
	await expect.poll(async () => (await answersOf(id)).length).toBeGreaterThan(0);
	return (await answersOf(id)).at(-1);
}

test("one MCP row and one approval card for both agents, with the declined-form notice", async ({
	page,
	context,
}) => {
	test.setTimeout(120_000);
	await page.emulateMedia({ colorScheme: "dark" });
	const student = await createStudent(context);

	// Claude's own tool name is mcp__github__search_issues, and its skill call a Skill row.
	const claude = await openChat(page, student.workspaceId, "MCP Claude", "claude");
	await sendMessage(claude.view, "demo mcp");
	const claudeCard = claude.view.getByTestId("chat-permission-card");
	await expect(claudeCard).toBeVisible({ timeout: 15_000 });
	expect(await expectAnnounced(claude.view)).toBe("Allow github to run search_issues?");
	await expect(claudeCard.getByRole("button")).toHaveText([
		/Allow once/,
		/Allow for this chat/,
		/Deny/,
	]);
	const claudeTurn = await openWork(claude.view);
	await expect(rowLine(claude.view, "skill-1")).toContainText("Used skill pdf");
	await expect(rowLine(claude.view, "card-mcp")).toContainText(
		"Used search_issues · github",
	);
	await expect(claudeTurn.getByTestId("chat-error")).toHaveText(NOTICE);
	await inBothThemes(page, () =>
		expectNoViolations(page, '[data-testid="chat-cards"]'),
	);
	await page.emulateMedia({ colorScheme: "dark" });
	await claudeCard.getByRole("button", { name: "Allow for this chat" }).click();
	expect(await lastAnswer(claude.id)).toMatchObject({
		id: "card-mcp",
		optionId: "always",
	});
	await expect(claudeTurn.getByTestId("chat-decision")).toHaveText([
		"Allowed for this chat: search_issues · github",
	]);

	// Codex's mcpToolCall reads and asks in the same words.
	const codex = await codexTurn(page, student.workspaceId, "MCP Codex");
	expect(await expectAnnounced(codex.view, 2)).toBe(
		"Allow github to run search_issues?",
	);
	const codexTurnLocator = await openWork(codex.view);
	await expect(rowLine(codex.view, "cx-mcp")).toContainText(
		"Used search_issues · github",
	);
	await expect(codexTurnLocator.getByTestId("chat-error")).toHaveText(NOTICE);
	await codex.view
		.getByTestId("chat-permission-card")
		.getByRole("button", { name: "Allow", exact: true })
		.click();
	expect(await lastAnswer(codex.id)).toMatchObject({ id: "cx-mcp", optionId: "allow" });
	await expect(codexTurnLocator.getByTestId("chat-decision").first()).toHaveText(
		"Allowed: search_issues · github",
	);
});

test("only the owner may attach to a Codex chat", async ({
	page,
	context,
	browser,
}) => {
	test.setTimeout(90_000);
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "Owner only", "codex");
	await expect(view.getByTestId("composer-model")).toBeAttached();

	const attach = (target: Page) =>
		target.evaluate(
			([workspaceId, terminalId]) =>
				new Promise<{ opened: boolean; frames: number }>((resolve) => {
					const scheme = location.protocol === "https:" ? "wss" : "ws";
					const socket = new WebSocket(
						`${scheme}://${location.host}/workspaces/${workspaceId}/terminals/${terminalId}/chat`,
					);
					let opened = false;
					let frames = 0;
					socket.onopen = () => {
						opened = true;
					};
					socket.onmessage = () => {
						frames++;
					};
					socket.onclose = () => resolve({ opened, frames });
					// The owner's socket stays open; give it time to say something, then end it.
					setTimeout(() => socket.close(), 2_500);
				}),
			[student.workspaceId, id],
		);

	// Another signed-in student is refused before the upgrade and gets nothing.
	const other = await browser.newContext();
	try {
		await createStudent(other);
		const otherPage = await other.newPage();
		await otherPage.goto("/");
		await expect(otherPage.getByRole("main").first()).toBeVisible({ timeout: 15_000 });
		expect(await attach(otherPage)).toEqual({ opened: false, frames: 0 });
	} finally {
		await other.close();
	}
	// Someone not signed in is refused too.
	const anonymous = await browser.newContext();
	try {
		const anonymousPage = await anonymous.newPage();
		await anonymousPage.goto("/");
		expect(await attach(anonymousPage)).toEqual({ opened: false, frames: 0 });
	} finally {
		await anonymous.close();
	}
	// The owner attaches and is told the chat's agent.
	const owner = await attach(page);
	expect(owner.opened).toBe(true);
	expect(owner.frames).toBeGreaterThan(0);
	await expect(view.getByTestId("composer-model")).toHaveText(/GPT-5\.5/);
});

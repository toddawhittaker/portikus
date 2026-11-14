import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	answersOf,
	type ChatAgent,
	chatTabIn,
	type Frame,
	makeChatTab,
	openChat,
	openChatOptions,
	receivedFrames,
	scriptChat,
	sendMessage,
	setMcpServers,
} from "./chat-helpers";
import {
	createProject,
	createStudent,
	expectNoViolations,
	query,
	workspacePath,
} from "./helpers";

/**
 * The Codex chat and what both agents share (SPEC.md §10.8, §25.8): rows in
 * Claude's styles, one MCP row and card, skills with each agent's own prefix,
 * cards by each button's decision, and the agent's name in every sentence.
 * The fake host speaks both agents through the API relay; a scripted socket
 * stands in for the host where the fake does not reach (every command kind,
 * add and delete diffs, several subagents, a secret with options).
 */

const SECRET = "tok-9f3a-never-shown";
const NOTICE =
	"A tool asked for input in a form the chat cannot show, so it was declined. Use a terminal tab for that tool.";

/** Run `check` in the dark theme, then in the light one (SPEC.md §25.8). */
async function inBothThemes(page: Page, check: () => Promise<void>) {
	for (const colorScheme of ["dark", "light"] as const) {
		await page.emulateMedia({ colorScheme });
		await check();
	}
}

/** Run `check` in a 360 px window, both themes, then give the window back. */
async function atPhoneWidth(page: Page, check: () => Promise<void>) {
	const wide = page.viewportSize() ?? { width: 1280, height: 720 };
	await page.setViewportSize({ width: 360, height: 800 });
	await inBothThemes(page, check);
	await page.emulateMedia({ colorScheme: "dark" });
	await page.setViewportSize(wide);
}

/** The newest turn with its folded work and every group of tool calls opened. */
async function openWork(view: Locator): Promise<Locator> {
	const turn = view.getByTestId("chat-turn").last();
	const worked = turn.getByTestId("chat-worked");
	if (!(await worked.evaluate((node) => (node as HTMLDetailsElement).open))) {
		await worked.locator("> summary").click();
	}
	const groups = turn.getByTestId("chat-tool-group");
	for (let at = 0; at < (await groups.count()); at++) {
		const group = groups.nth(at);
		if (!(await group.evaluate((node) => (node as HTMLDetailsElement).open))) {
			await group.locator("> summary").click();
		}
	}
	return turn;
}

/** A tool row's summary line: the sentence the conversation shows for the call. */
function rowLine(view: Locator, id: string): Locator {
	return view.getByTestId(`chat-tool-${id}`).locator("> summary");
}

/** What a screen reader is told: exactly the card's heading, as a sentence. */
async function expectAnnounced(view: Locator, waiting = 0) {
	const heading =
		(
			await view.getByTestId("chat-cards").getByRole("heading").first().textContent()
		)?.trim() ?? "";
	const said = heading.endsWith("?") ? heading : `${heading}.`;
	const more =
		waiting === 0
			? ""
			: ` ${waiting === 1 ? "1 more request is waiting." : `${waiting} more requests are waiting.`}`;
	await expect(view.getByTestId("chat-announcer")).toHaveText(`${said}${more}`);
	return heading;
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

/** A scripted Codex chat's host: the rows and cards `first` sends, answered by `reply`. */
async function scriptedCodex(
	page: Page,
	context: Parameters<typeof makeChatTab>[1],
	frames: Frame[],
	options: {
		snapshot?: object;
		reply?: Parameters<typeof scriptChat>[2]["reply"];
		agent?: ChatAgent;
	} = {},
) {
	const agent = options.agent ?? "codex";
	const tab = await makeChatTab(page, context, agent);
	const view = await scriptChat(page, tab.id, {
		agent,
		snapshot: options.snapshot,
		first: frames,
		reply: options.reply,
	});
	return { ...tab, view };
}

/** A finished tool call, as the host sends it. */
function call(id: string, name: string, input: object, title = name): Frame[] {
	return [
		["tool.started", { id, name, title, input }],
		["tool.finished", { id, isError: false }],
	];
}

const SESSION = "00000000-0000-4000-8000-000000000000";
const AT = Date.now() - 60_000;
const TURN_OPEN: Frame[] = [
	["message", { id: "u1", role: "user", markdown: "Tidy the project" }],
	["turn.started", { at: AT }],
];
/** A turn that is running and has shown some work. */
const WORKING: Frame[] = [
	["turn.started", { at: AT }],
	["message", { id: "w1", role: "assistant", markdown: "Looking at the tests." }],
];
const TURN_CLOSE: Frame[] = [
	["message", { id: "a1", role: "assistant", markdown: "All done." }],
	["turn.finished", { at: AT + 5_000, status: "done" }],
];

test.describe("Codex rows the fake host does not send", () => {
	test.describe.configure({ timeout: 90_000 });

	test("a command reads by what Codex says it did, and an unknown one keeps its command", async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: "dark" });
		const command = (id: string, text: string, actions: object[]) =>
			call(id, "commandExecution", { command: text, actions }, text);
		const { view } = await scriptedCodex(page, context, [
			...TURN_OPEN,
			...command("c1", "cat src/a.ts", [{ type: "read", path: "src/a.ts" }]),
			...command("c2", "ls src", [{ type: "listFiles", path: "src" }]),
			...command("c3", "ls", [{ type: "listFiles", path: null }]),
			...command("c4", "rg foo src", [{ type: "search", query: "foo", path: "src" }]),
			...command("c5", "rg bar", [{ type: "search", query: "bar", path: null }]),
			...command("c6", "make build", [{ type: "unknown" }]),
			...command("c7", "cat a && ls", [
				{ type: "read", path: "a" },
				{ type: "listFiles", path: "." },
			]),
			...TURN_CLOSE,
		]);
		await expect(view.getByText("All done.")).toBeVisible({ timeout: 15_000 });
		await openWork(view);
		const lines: [string, string][] = [
			["c1", "Read a.ts"],
			["c2", "Listed files in src"],
			["c3", "Listed files"],
			["c4", "Searched for foo in src"],
			["c5", "Searched for bar"],
			["c6", "Ran make build"],
			["c7", "Ran cat a && ls"],
		];
		for (const [id, text] of lines) {
			await expect(rowLine(view, id)).toContainText(text);
		}
		// A read of a file in a folder keeps its whole path where the name is cut short.
		await expect(rowLine(view, "c1")).toContainText("Read a.ts");
		await expect(rowLine(view, "c3")).not.toContainText("Listed files in");
		await expectNoViolations(page, '[data-testid="chat-scroll"]');
	});

	test("file changes draw one diff per file, and Files changed counts the delete too", async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: "dark" });
		const hunk = (before: string, after: string, name: string) =>
			[
				`--- a/${name}`,
				`+++ b/${name}`,
				"@@ -1 +1 @@",
				`-${before}`,
				`+${after}`,
				"",
			].join("\n");
		const change = (id: string, changes: object[]) =>
			call(id, "fileChange", { changes }, "files");
		const { view } = await scriptedCodex(page, context, [
			...TURN_OPEN,
			...change("f1", [
				{ path: "src/new.ts", kind: "add", diff: "export const n = 1;\n" },
			]),
			...change("f2", [
				{ path: "src/old.ts", kind: "delete", diff: "export const o = 1;\n" },
			]),
			...change("f3", [
				{
					path: "src/up.ts",
					kind: "update",
					diff: hunk("export const u = 1;", "export const u = 2;", "src/up.ts"),
				},
			]),
			...change("f4", [
				{
					path: "src/a.ts",
					kind: "update",
					movePath: "src/b.ts",
					diff: hunk("export const m = 1;", "export const m = 2;", "src/a.ts"),
				},
			]),
			...TURN_CLOSE,
		]);
		await expect(view.getByText("All done.")).toBeVisible({ timeout: 15_000 });
		const turn = await openWork(view);
		for (const [id, text] of [
			["f1", "Created src/new.ts"],
			["f2", "Deleted src/old.ts"],
			["f3", "Edited src/up.ts"],
			["f4", "Moved src/b.ts"],
		] as const) {
			await expect(rowLine(view, id)).toContainText(text);
			await rowLine(view, id).click();
		}
		// Each file is a group named by its verb and path, with its lines marked in words and colour.
		const added = view.getByTestId("chat-tool-f1").getByRole("group", {
			name: "Created src/new.ts",
		});
		await expect(added).toContainText("export const n = 1;");
		const deleted = view.getByTestId("chat-tool-f2").getByRole("group", {
			name: "Deleted src/old.ts",
		});
		await expect(deleted).toContainText("export const o = 1;");
		await expect(
			view.getByTestId("chat-tool-f3").getByRole("group", { name: "Edited src/up.ts" }),
		).toContainText("export const u = 2;");
		await expect(
			view
				.getByTestId("chat-tool-f4")
				.getByRole("group", { name: "Moved src/a.ts → src/b.ts" }),
		).toContainText("export const m = 2;");

		// The turn's own line counts all four files, the deleted one included.
		const files = turn.getByTestId("chat-files-changed");
		await expect(files).toContainText("4 files changed");
		await files.locator("> summary").click();
		await expect(files.getByTestId("chat-changed-file")).toHaveCount(4);
		await expect(files.getByTestId("chat-changed-file").nth(1)).toContainText(
			"src/old.ts",
		);
		await inBothThemes(page, () =>
			expectNoViolations(page, '[data-testid="chat-scroll"]'),
		);

		// At 360 px the diffs scroll in their boxes and the page does not.
		await page.setViewportSize({ width: 360, height: 800 });
		await inBothThemes(page, () =>
			expectNoViolations(page, '[data-testid="chat-scroll"]'),
		);
		expect(
			await page.evaluate(
				() =>
					document.documentElement.scrollWidth - document.documentElement.clientWidth,
			),
		).toBeLessThanOrEqual(0);
	});

	test("a file change card asks per file, and a delete is worded as one", async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: "dark" });
		const { view } = await scriptedCodex(page, context, [], {
			snapshot: {
				turnRunning: true,
				cards: [
					{
						type: "permission",
						id: "fc1",
						toolName: "fileChange",
						title: "src/old.ts",
						input: {
							changes: [
								{ path: "src/old.ts", kind: "delete", diff: "export const o = 1;\n" },
							],
						},
						options: [
							{ id: "allow", label: "Allow", decision: "allowed" },
							{ id: "deny", label: "Deny", decision: "denied" },
						],
					},
				],
			},
		});
		const card = view.getByTestId("chat-permission-card");
		await expect(card).toBeVisible({ timeout: 15_000 });
		await expect(card.getByRole("heading", { level: 2 })).toHaveText(
			"Codex wants to delete a file",
		);
		await expect(view.getByTestId("chat-announcer")).toHaveText(
			"Codex wants to delete a file.",
		);
		await expect(
			card.getByRole("group", { name: /src\/old\.ts/ }).first(),
		).toContainText("export const o = 1;");
		await inBothThemes(page, () =>
			expectNoViolations(page, '[data-testid="chat-cards"]'),
		);
		await page.setViewportSize({ width: 360, height: 800 });
		await inBothThemes(page, () =>
			expectNoViolations(page, '[data-testid="chat-cards"]'),
		);
	});

	test("a subagent tool row opens the panel by child thread id, one button per child", async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: "dark" });
		const watched: { type: string; toolUseId: string }[] = [];
		const childSeqs = new Map<string, number>();
		const { view } = await scriptedCodex(
			page,
			context,
			[
				...TURN_OPEN,
				...call("cb1", "collabAgentToolCall", {
					tool: "spawnAgent",
					receivers: ["child-1", "child-2"],
					prompt: "Check the tests",
				}),
				...call("cb2", "collabAgentToolCall", { tool: "wait", receivers: ["child-1"] }),
				...call("cb3", "collabAgentToolCall", {
					tool: "sendInput",
					receivers: ["child-2"],
				}),
				...call("cb4", "collabAgentToolCall", {
					tool: "closeAgent",
					receivers: ["child-2"],
				}),
				...call("cb5", "collabAgentToolCall", { tool: "listAgents", receivers: [] }),
				...TURN_CLOSE,
			],
			{
				reply: (message, send) => {
					const watch = message as { type: string; toolUseId: string };
					if (!watch.type.startsWith("subagent.")) return;
					watched.push(watch);
					if (watch.type !== "subagent.watch") return;
					const event = (type: string, body: object) => {
						const seq = childSeqs.get(watch.toolUseId) ?? 0;
						childSeqs.set(watch.toolUseId, seq + 1);
						send([
							"subagent",
							{
								toolUseId: watch.toolUseId,
								event: { type, sessionId: SESSION, seq, ...body },
							},
						]);
					};
					event("snapshot", { cards: [], turnRunning: false, truncated: false });
					event("message", {
						id: "s1",
						role: "assistant",
						markdown: `Looked at ${watch.toolUseId}.`,
					});
				},
			},
		);
		await expect(view.getByText("All done.")).toBeVisible({ timeout: 15_000 });
		await openWork(view);
		for (const [row, text] of [
			["cb1", "Started 2 subagents"],
			["cb2", "Waited for a subagent"],
			["cb3", "Sent input to a subagent"],
			["cb4", "Closed a subagent"],
			["cb5", "Listed subagents"],
		] as const) {
			await expect(rowLine(view, row)).toContainText(text);
		}
		await rowLine(view, "cb1").click();
		const open = view
			.getByTestId("chat-tool-cb1")
			.getByRole("button", { name: /Show subagent \d's conversation/ });
		await expect(open).toHaveText([
			"Show subagent 1's conversation",
			"Show subagent 2's conversation",
		]);
		await open.nth(1).click();

		const panel = view.getByRole("region", { name: "Subagent 2" });
		await expect(panel).toBeVisible();
		await expect(panel.getByText("Looked at child-2.")).toBeVisible();
		await expect(panel.getByTestId("subagent-note")).toHaveText(
			"Read only. You cannot send a subagent a message here; to pass one on, ask Codex in the chat below.",
		);
		await inBothThemes(page, () => expectNoViolations(page));
		await page.keyboard.press("Escape");
		await expect(panel).toHaveCount(0);
		// The dev server mounts a view twice, so the pair may repeat; each names the child by its id.
		expect(new Set(watched.map((one) => one.toolUseId))).toEqual(new Set(["child-2"]));
		expect(watched[0]?.type).toBe("subagent.watch");
		expect(watched.at(-1)?.type).toBe("subagent.unwatch");
		// The panel follows the child by its id, so the first child opens its own.
		await open.nth(0).click();
		await expect(
			view.getByRole("region", { name: "Subagent 1" }).getByText("Looked at child-1."),
		).toBeVisible();
	});

	test("a secret question with options masks Other, and the answer is never drawn", async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: "dark" });
		const questions = [
			{
				question: "Which key should I use?",
				header: "Key",
				multiSelect: false,
				secret: true,
				options: [{ label: "The work key", description: "Stored in the project" }],
			},
		];
		const answers: unknown[] = [];
		const { view } = await scriptedCodex(
			page,
			context,
			[
				...TURN_OPEN,
				// The conversation's record of the question, which must not echo the answer.
				[
					"tool.started",
					{ id: "q1", name: "AskUserQuestion", title: "Ask", input: { questions } },
				],
			],
			{
				snapshot: {
					turnRunning: true,
					cards: [{ type: "question", id: "q1", questions }],
				},
				reply: (message, send) => {
					if (message.type !== "question.answer") return;
					answers.push(message);
					send(["card.resolved", { id: "q1" }]);
					send([
						"tool.output",
						{
							id: "q1",
							part: {
								type: "text",
								text: `Your questions have been answered: "Which key should I use?"="${SECRET}".`,
							},
						},
					]);
					send(["tool.finished", { id: "q1", isError: false }]);
					send(["turn.finished", { at: AT + 9_000, status: "done" }]);
				},
			},
		);
		const card = view.getByTestId("chat-question-card");
		await expect(card).toBeVisible({ timeout: 15_000 });
		await card.getByRole("radio", { name: "Other" }).check();
		const other = card.getByTestId("chat-question-other");
		await expect(other).toHaveAttribute("type", "password");
		await expect(other).toHaveAttribute("autocomplete", "off");
		await expect(other).toHaveAccessibleDescription(
			"Hidden as you type. It goes to Codex and is not shown in the conversation.",
		);
		await other.fill(SECRET);
		await inBothThemes(page, () =>
			expectNoViolations(page, '[data-testid="chat-cards"]'),
		);
		await page.setViewportSize({ width: 360, height: 800 });
		await inBothThemes(page, () =>
			expectNoViolations(page, '[data-testid="chat-cards"]'),
		);
		await card.getByTestId("chat-question-next").click();
		await expect(card).toHaveCount(0);
		expect(answers).toMatchObject([
			{
				type: "question.answer",
				id: "q1",
				answers: { "Which key should I use?": SECRET },
			},
		]);
		await expect(view.getByTestId("chat-asked")).toBeVisible();
		await expect(view.getByTestId("chat-asked")).toContainText("Answered (not shown)");
		await view.getByTestId("chat-asked").locator("> summary").click();
		await expect(view).not.toContainText(SECRET);
		expect(await page.content()).not.toContain(SECRET);
	});
});

for (const agent of ["claude", "codex"] as const) {
	const name = agent === "claude" ? "Claude" : "Codex";

	test(`${name}'s name is in the byline, the card, the deny field and "Sent while ${name} was working"`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		const sent: unknown[] = [];
		const { view } = await scriptedCodex(page, context, WORKING, {
			agent,
			snapshot: {
				turnRunning: true,
				cards: [
					{
						type: "permission",
						id: "p1",
						toolName: agent === "claude" ? "Bash" : "commandExecution",
						title: "npm test",
						input: { command: "npm test", actions: [{ type: "unknown" }] },
						options: [
							{ id: "allow", label: "Allow", decision: "allowed" },
							{ id: "deny", label: "Deny", decision: "denied" },
						],
					},
				],
			},
			// The host echoes what the student sent, and a turn that is running marks it.
			reply: (message, send) => {
				if (message.type !== "send") return;
				sent.push(message);
				send(["message", { id: "u2", role: "user", markdown: "Also add a test" }]);
			},
		});
		const card = view.getByTestId("chat-permission-card");
		await expect(card).toBeVisible({ timeout: 15_000 });
		await expect(card.getByRole("heading", { level: 2 })).toHaveText(
			`${name} wants to run a command`,
		);
		await expectAnnounced(view);
		await expect(view.getByTestId("chat-announcer")).toHaveText(
			`${name} wants to run a command.`,
		);
		await expect(view.getByTestId("chat-composer-input")).toHaveAttribute(
			"aria-label",
			agent === "claude" ? "Message Claude Code" : "Message Codex",
		);
		await card.getByRole("button", { name: "Deny" }).click();
		await expect(view.getByLabel(`Tell ${name} what to do instead`)).toBeFocused();
		await page.keyboard.press("Escape");

		// A message sent while the agent works is marked, in the agent's name.
		await sendMessage(view, "Also add a test");
		await expect(view.getByTestId("chat-sent-while-working")).toHaveText(
			`Sent while ${name} was working`,
		);
		expect(sent).toMatchObject([{ type: "send", text: "Also add a test" }]);
	});
}

for (const agent of ["claude", "codex"] as const) {
	const name = agent === "claude" ? "Claude" : "Codex";

	test(`/mcp shows ${name}'s servers with a word for each state, live, and a long name wraps`, async ({
		page,
		context,
	}) => {
		test.setTimeout(120_000);
		await page.emulateMedia({ colorScheme: "dark" });
		const student = await createStudent(context);
		const { id, view } = await openChat(page, student.workspaceId, "MCP list", agent);
		const box = view.getByTestId("chat-composer-input");
		await box.click();
		await page.keyboard.type("/mc");
		await page.keyboard.press("Enter");
		const field = view.getByTestId("composer-mcp");
		await expect(field).toHaveAttribute("aria-expanded", "true");
		const list = view.getByRole("region", { name: "MCP servers" });
		await expect(list.getByRole("listitem")).toHaveText([
			/github\s*Connected/,
			/docs\s*Needs sign-in/,
		]);
		expect(await receivedFrames(id, "send")).toEqual([]);

		// The host's list replaces it live, every state in words.
		const longName = `a-server-with-an-unbroken-name-${"x".repeat(33)}`;
		await setMcpServers(id, [
			{ name: "one", status: "connected" },
			{ name: "two", status: "starting" },
			{ name: "three", status: "failed" },
			{ name: "four", status: "needsAuth" },
			{ name: "five", status: "disabled" },
			{ name: longName, status: "connected" },
		]);
		await expect(list.getByRole("listitem")).toHaveText([
			/one\s*Connected/,
			/two\s*Starting/,
			/three\s*Failed/,
			/four\s*Needs sign-in/,
			/five\s*Disabled/,
			new RegExp(`${longName}\\s*Connected`),
		]);
		await expect(field).toHaveText(/MCP servers\s*2 of 6 connected/);
		await expect(list).toContainText(
			`Servers are managed in a terminal, with ${agent} mcp.`,
		);
		await inBothThemes(page, () => expectNoViolations(page));

		// At 360 px the long name wraps inside the list instead of running past it.
		await page.setViewportSize({ width: 360, height: 800 });
		await expect(list.getByRole("listitem").last()).toBeVisible();
		const spill = await list.evaluate((node) => node.scrollWidth - node.clientWidth);
		expect(spill).toBeLessThanOrEqual(0);
		await inBothThemes(page, () => expectNoViolations(page));
		expect(
			await page.evaluate(
				() =>
					document.documentElement.scrollWidth - document.documentElement.clientWidth,
			),
		).toBeLessThanOrEqual(0);
	});
}

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

test.describe("skills and commands", () => {
	test.describe.configure({ timeout: 90_000 });

	test("a skill is /name in a Claude chat, $name in a Codex chat, and $ opens a skills-only list only for Codex", async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: "dark" });
		const student = await createStudent(context);

		const claude = await openChat(page, student.workspaceId, "Skills Claude", "claude");
		const claudeBox = claude.view.getByTestId("chat-composer-input");
		await claudeBox.click();
		await page.keyboard.type("/pd");
		await expect(
			claude.view.getByRole("listbox", { name: "Commands" }).getByRole("option"),
		).toHaveText([/\/pdf/]);
		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.press("Backspace");
		// In a Claude chat a dollar sign is only a dollar sign.
		await page.keyboard.type("$");
		await expect(claude.view.getByRole("listbox")).toHaveCount(0);
		await expect(claudeBox).toHaveText("$");

		const codex = await openChat(page, student.workspaceId, "Skills Codex", "codex");
		const box = codex.view.getByTestId("chat-composer-input");
		await box.click();
		await page.keyboard.type("/");
		const commands = codex.view.getByRole("listbox", { name: "Commands" });
		await expect(commands.getByRole("option", { name: /\$pdf/ })).toBeVisible();
		await expect(commands.getByRole("option", { name: /\/pdf/ })).toHaveCount(0);
		await expect(commands.getByRole("option", { name: /\/mcp/ })).toBeVisible();
		await page.keyboard.press("Escape");
		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.press("Backspace");

		await page.keyboard.type("$");
		const skills = codex.view.getByRole("listbox", { name: "Skills" });
		await expect(skills.getByRole("option")).toHaveText([/\$pdf/]);
		await inBothThemes(page, () => expectNoViolations(page));
		await page.keyboard.press("Enter");
		await expect(box).toHaveText("$pdf");
		// A skill goes as plain text, which Codex expands itself.
		await page.keyboard.type("fill in the form");
		await page.keyboard.press("Enter");
		await expect
			.poll(async () => (await receivedFrames(codex.id, "send")).map((f) => f.text))
			.toEqual(["$pdf fill in the form"]);
	});

	test("/model, /effort and /permissions open their pickers in a Codex chat and are never sent", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { id, view } = await openChat(page, student.workspaceId, "Bare", "codex");
		const box = view.getByTestId("chat-composer-input");
		for (const [command, picker] of [
			["/model", "composer-model"],
			["/effort", "composer-effort"],
			["/permissions", "composer-mode"],
		] as const) {
			await box.click();
			await page.keyboard.type(command);
			await page.keyboard.press("Escape");
			await page.keyboard.press("Enter");
			await expect(view.getByTestId(picker)).toHaveAttribute("aria-expanded", "true");
			await page.keyboard.press("Escape");
			await expect(box).toHaveText("");
		}
		expect(await receivedFrames(id, "send")).toEqual([]);
	});
});

test.describe("Codex pickers", () => {
	test.describe.configure({ timeout: 90_000 });

	/** The pickers, by test id: an open menu hides the rest of the page from role queries. */
	const picker = (view: Locator, testId: string) => view.getByTestId(testId);
	const menu = (page: Page, label: string) =>
		page.getByRole("menu", { name: new RegExp(`^${label} `) });

	test("each model lists its own efforts, and the five modes carry Full access's warning", async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: "dark" });
		const student = await createStudent(context);
		const { view } = await openChat(page, student.workspaceId, "Codex models", "codex");
		await openChatOptions(view);

		await picker(view, "composer-effort").click();
		let efforts = menu(page, "Effort").getByRole("menuitemradio");
		await expect(efforts).toHaveText([
			/Low/,
			/Medium\s*Default/,
			/High/,
			/Extra high/,
			/ultra/,
		]);
		await page.keyboard.press("Escape");

		await picker(view, "composer-model").click();
		await menu(page, "Model")
			.getByRole("menuitemradio", { name: /GPT-5\.4 mini/ })
			.click();
		await expect(picker(view, "composer-model")).toHaveText(/GPT-5\.4 mini/);
		await picker(view, "composer-effort").click();
		efforts = menu(page, "Effort").getByRole("menuitemradio");
		await expect(efforts).toHaveText([/Low/, /Medium\s*Default/, /High/]);
		await page.keyboard.press("Escape");

		await picker(view, "composer-mode").click();
		const modes = menu(page, "Permissions").getByRole("menuitemradio");
		await expect(modes).toHaveText([/Ask/, /Read only/, /Plan/, /Auto/, /Full access/]);
		await modes.last().click();
		await expect(view.getByTestId("chat-bypass-warning")).toHaveText(
			"Full access lets Codex run every command without asking you first.",
		);
		await inBothThemes(page, () =>
			expectNoViolations(page, '[data-testid="composer-picks"]'),
		);
	});

	test("Full access is never carried into a new Codex chat, while the model and effort are", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Carry" });
		// What a student's last Codex chat saved, Full access included; a new chat reads it as Auto.
		await query("update projects set chat_settings = $2 where id = $1", [
			project.id,
			JSON.stringify({
				model: "opus",
				effort: "medium",
				mode: "auto",
				agent: "codex",
				codex: { model: "gpt-5.4", effort: "high", mode: "fullAccess" },
			}),
		]);
		const tabId = await chatTabIn(page, student.workspaceId, project.id, "codex");
		const tab = { id: tabId };
		const sets: Record<string, unknown>[] = [];
		let current = { model: "gpt-5.5", effort: "medium", mode: "untrusted" };
		await page.routeWebSocket(/\/chat$/, (ws) => {
			let seq = 0;
			const send = (type: string, body: object = {}) =>
				ws.send(JSON.stringify({ type, sessionId: tab.id, seq: seq++, ...body }));
			send("snapshot", { cards: [], turnRunning: false, truncated: false });
			send("models", {
				models: [
					{
						value: "gpt-5.5",
						displayName: "GPT-5.5",
						description: "Frontier",
						supportsAutoMode: true,
						efforts: ["low", "medium", "high", "ultra"],
						defaultEffort: "medium",
					},
					{
						value: "gpt-5.4",
						displayName: "GPT-5.4",
						description: "Everyday",
						supportsAutoMode: true,
						efforts: ["low", "medium", "high"],
						defaultEffort: "medium",
					},
				],
			});
			send("modes", {
				modes: [
					{
						id: "untrusted",
						label: "Ask",
						description: "Asks.",
						warning: false,
						plan: false,
					},
					{
						id: "onRequest",
						label: "Auto",
						description: "Auto.",
						warning: false,
						plan: false,
					},
					{
						id: "fullAccess",
						label: "Full access",
						description:
							"Full access lets Codex run every command without asking you first.",
						warning: true,
						plan: false,
					},
				],
			});
			send("settings", { agent: "codex", ...current });
			ws.onMessage((raw) => {
				const message = JSON.parse(String(raw));
				if (message.type !== "set") return;
				sets.push(message);
				const { type: _type, ...change } = message;
				current = { ...current, ...change };
				send("settings", { agent: "codex", ...current });
			});
		});
		await page.goto(workspacePath(student.workspaceId, project.id));
		const view = page.getByTestId(`chat-view-${tab.id}`);
		await expect(view.getByTestId("composer-model")).toBeAttached({ timeout: 15_000 });
		await openChatOptions(view);
		await expect(view.getByTestId("composer-model")).toHaveText(/GPT-5\.4/, {
			timeout: 15_000,
		});
		await openChatOptions(view);
		await expect(view.getByTestId("composer-effort")).toHaveText(/High/);
		await expect(view.getByTestId("composer-mode")).toHaveText(/Auto/);
		await expect(view.getByTestId("chat-bypass-warning")).toHaveCount(0);
		for (const set of sets) expect(set.mode).not.toBe("fullAccess");
	});

	test("Claude's pickers keep Claude's own models, efforts and modes", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { view } = await openChat(
			page,
			student.workspaceId,
			"Claude pickers",
			"claude",
		);
		await openChatOptions(view);
		await expect(view.getByTestId("composer-agent")).toHaveText(/Claude Code/);
		await view.getByTestId("composer-mode").click();
		await expect(menu(page, "Permissions").getByRole("menuitemradio")).toHaveText([
			/Ask/,
			/Accept edits/,
			/Plan/,
			/Auto/,
			/Bypass permissions/,
		]);
		await page.keyboard.press("Escape");
		await view.getByTestId("composer-effort").click();
		await expect(
			menu(page, "Effort").getByRole("menuitemradio", { name: /ultra/ }),
		).toHaveCount(0);
		await page.keyboard.press("Escape");
		await view.getByTestId("composer-model").click();
		await expect(
			menu(page, "Model").getByRole("menuitemradio", { name: /GPT/ }),
		).toHaveCount(0);
	});
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

import { expect, type Page, test } from "@playwright/test";
import {
	type ChatAgent,
	expectAnnounced,
	type Frame,
	inBothThemes,
	makeChatTab,
	openChat,
	openWork,
	rowLine,
	scriptChat,
	sendMessage,
	setMcpServers,
} from "./chat-helpers";
import { createStudent, expectNoViolations } from "./helpers";

/**
 * Codex rows and cards the fake host does not send (SPEC.md §10.8, §25.8),
 * from a scripted socket standing in for the host: every command kind, add
 * and delete diffs, several subagents, a secret with options, and the
 * agent's name in every sentence of both agents.
 */

const SECRET = "tok-9f3a-never-shown";

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

import {
	type BrowserContext,
	expect,
	type Locator,
	type Page,
	test,
	type WebSocketRoute,
} from "@playwright/test";
import {
	addSession,
	createProject,
	createStudent,
	endTerminal,
	expectNoViolations,
	newTerminal,
	query,
	terminalIds,
	waitForSavedLeaf,
	workspacePath,
	workTabs,
} from "./helpers";
import { png } from "./png";
import { FAKE_AGENT_URL } from "./ports";

/**
 * The chat tab's conversation and cards (SPEC.md §8.3, §10.8, §25.8). The
 * page's chat socket is answered by a script in the test, so each frame
 * and each answer is exact; the fake agent's chat covers the API relay.
 */

const QUESTION = {
	id: "q1",
	questions: [
		{
			question: "Which layout should the dashboard use?",
			header: "Layout",
			multiSelect: false,
			options: [
				{
					label: "Grid",
					description: "Cards in rows and columns",
					preview: "+--------+--------+\n| Builds | Tests  |\n+--------+--------+",
				},
				{
					label: "Stack",
					description: "One column, newest first",
					preview:
						"+-----------------+\n| Builds          |\n| Tests           |\n+-----------------+",
				},
			],
		},
		{
			question: "Which checks should run on save?",
			header: "Checks",
			multiSelect: true,
			options: [
				{ label: "Lint", description: "Biome" },
				{ label: "Types", description: "tsc --noEmit" },
				{ label: "Tests", description: "Only the changed files" },
			],
		},
	],
};

const PERMISSION = {
	id: "p1",
	toolName: "Bash",
	title: "Run the unit tests",
	input: { command: "pnpm vitest run src/dashboard", timeout: 120000 },
	options: [
		{ id: "allow", label: "Allow" },
		{ id: "always", label: "Allow for this session" },
		{ id: "deny", label: "Deny" },
	],
};

/** Plays a short turn, then the cards, answering as the fake chat will. */
function script(ws: WebSocketRoute, answers: unknown[]) {
	let seq = 0;
	const session = "00000000-0000-4000-8000-000000000000";
	const send = (type: string, body: Record<string, unknown> = {}) =>
		ws.send(JSON.stringify({ type, sessionId: session, seq: seq++, ...body }));
	const at = Date.now() - 223_000;
	send("snapshot", { cards: [], turnRunning: false, truncated: true });
	send("message", {
		id: "u1",
		role: "user",
		markdown: "Make the dashboard load faster and show me what changed.",
	});
	send("turn.started", { at });
	send("text.delta", {
		messageId: "a1",
		text: "I'll start by profiling the **dashboard** route. ",
	});
	send("text.delta", {
		messageId: "a1",
		text: "![tracking](https://remote-image.example/leak.png?q=secret)",
	});
	send("message", {
		id: "a1",
		role: "assistant",
		markdown:
			"I'll start by profiling the **dashboard** route. ![tracking](https://remote-image.example/leak.png?q=secret)",
	});
	send("tool.started", {
		id: "t1",
		name: "Screenshot",
		title: "http://localhost:5173/dashboard",
		input: { url: "http://localhost:5173/dashboard", fullPage: false },
	});
	send("tool.output", {
		id: "t1",
		part: { type: "text", text: "Saved 320x180 screenshot" },
	});
	send("tool.output", {
		id: "t1",
		part: { type: "image", mediaType: "image/png", data: png(320, 180) },
	});
	send("tool.output", {
		id: "t1",
		part: { type: "imageOmitted", mediaType: "image/png" },
	});
	send("tool.finished", { id: "t1", isError: false });
	send("tool.started", {
		id: "t2",
		name: "Bash",
		title:
			"grep -R useDashboardQuery src/averyveryveryverylongunbrokenpathsegmentthatkeepsgoing",
		input: { command: "grep -R useDashboardQuery src" },
	});
	send("tool.output", {
		id: "t2",
		part: { type: "text", text: "grep: src/missing: No such file or directory" },
	});
	send("tool.finished", { id: "t2", isError: true });
	send("message", {
		id: "a2",
		role: "assistant",
		markdown: "The query runs twice on mount.",
	});
	send("message", {
		id: "a3",
		role: "assistant",
		markdown:
			"Done. The dashboard now loads its data **once**.\n\n- Removed the duplicate query\n- Added a test\n\n```ts\nconst data = useDashboardQuery();\n```\n\nSee [the React docs](https://react.dev/reference/react/useEffect).",
	});
	send("turn.finished", { at: at + 223_000, status: "done" });
	send("settings", {
		agent: "claude",
		model: "default",
		effort: "high",
		mode: "default",
	});
	send("question.requested", QUESTION);
	ws.onMessage((raw) => {
		const message = JSON.parse(String(raw));
		answers.push(message);
		if (message.type === "question.answer") {
			send("card.resolved", { id: "q1" });
			send("permission.requested", PERMISSION);
		}
		if (message.type === "permission.answer") send("card.resolved", { id: "p1" });
	});
}

/**
 * A chat tab in a new student's workspace. The launcher entry is the
 * composer's, so a terminal is opened and its row made a chat; the fake
 * agent already knows the terminal, and the API reads the kind from the row.
 */
async function makeChatTab(page: Page, context: BrowserContext) {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Dashboard" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [id] = await terminalIds(student.workspaceId, project.id);
	await query(
		"update terminals set kind = 'chat', agent = 'claude', name = 'Claude Code' where id = $1",
		[id],
	);
	if (!id) throw new Error("the terminal row was not created");
	return { student, project, id };
}

/** The chat tab with its socket answered by `script`, not the fake agent. */
async function openScriptedChat(page: Page, context: BrowserContext) {
	const { id } = await makeChatTab(page, context);
	const answers: unknown[] = [];
	await page.routeWebSocket(/\/chat$/, (ws) => script(ws, answers));
	const remote: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("remote-image.example")) remote.push(request.url());
	});
	await page.reload();
	await expect(page.getByTestId(`chat-view-${id}`)).toBeVisible({ timeout: 15_000 });
	return { id, answers, remote };
}

for (const colorScheme of ["light", "dark"] as const) {
	for (const width of [360] as const) {
		test(`scripted chat (${colorScheme}, ${width})`, async ({ page, context }) => {
			test.setTimeout(90_000);
			await page.emulateMedia({ colorScheme });
			await page.setViewportSize({ width, height: 900 });
			const { id, answers, remote } = await openScriptedChat(page, context);
			const view = page.getByTestId(`chat-view-${id}`);
			await expect(
				view.getByText("Done. The dashboard now loads its data"),
			).toBeVisible();
			await expect(view.getByTestId("chat-question-card")).toBeVisible();
			// The replayed turn keeps its real length.
			await expect(view.getByTestId("chat-worked").locator("> summary")).toHaveText(
				/^Worked for 3m 4[2-4]s2 tool calls$/,
			);
			await view.getByTestId("chat-worked").locator("> summary").click();
			await view.getByTestId("chat-tool-t1").locator("> summary").click();
			await expect(
				view.getByRole("img", { name: "Output of Screenshot" }),
			).toBeVisible();
			await expect(view.getByTestId("chat-question-card")).toBeVisible();
			await view.getByTestId("chat-tool-t2").locator("> summary").click();
			await view.locator(".pk-chat-scroll").evaluate((box) => box.scrollTo(0, 0));
			await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);

			// Keyboard only from here, starting where the card put the focus.
			await view.getByRole("radio", { name: "Grid" }).focus();
			await page.keyboard.press("ArrowDown");
			await expect(view.getByTestId("chat-question-preview").first()).toContainText(
				"Tests           |",
			);
			await page.keyboard.press("Tab"); // Other text
			await page.keyboard.press("Tab"); // preview
			await page.keyboard.press("Tab"); // Add a note
			await page.keyboard.press("Enter");
			await expect(
				view.getByRole("textbox", { name: "Notes (optional)" }),
			).toBeFocused();
			await page.keyboard.type("Keep it simple");
			await page.keyboard.press("Tab"); // first checkbox
			await page.keyboard.press("Space");
			await page.keyboard.press("Tab");
			await page.keyboard.press("Tab");
			await page.keyboard.press("Space");
			await page.keyboard.press("Tab"); // Other
			await page.keyboard.type("and a build");
			await page.keyboard.press("Enter");
			await expect(view.getByTestId("chat-question-card")).toHaveCount(0);
			await expect(view.getByTestId("chat-permission-card")).toBeVisible();
			// The answered card handed the keyboard to the message box, and the next
			// card does not take it from there.
			await expect(view.getByTestId("chat-composer-input")).toBeFocused();
			await page.keyboard.press("Shift+Tab");
			await expect(view.getByRole("button", { name: "Deny" })).toBeFocused();
			await view.getByRole("button", { name: "Allow", exact: true }).focus();
			await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);
			await page.keyboard.press("Enter");
			await expect(view.getByTestId("chat-permission-card")).toHaveCount(0);
			expect(answers).toEqual([
				{
					type: "question.answer",
					id: "q1",
					answers: {
						"Which layout should the dashboard use?": "Stack",
						"Which checks should run on save?": "Lint, Tests",
					},
					notes: {
						"Which layout should the dashboard use?": "Keep it simple",
						"Which checks should run on save?": "and a build",
					},
				},
				{ type: "permission.answer", id: "p1", optionId: "allow" },
			]);
			expect(remote).toEqual([]);
			const overflow = await view.evaluate(
				(node) => node.scrollWidth - node.clientWidth,
			);
			expect(overflow).toBe(0);
		});
	}
}

interface FakeAnswers {
	answers: unknown[];
}

async function fakeAnswers(terminalId: string): Promise<unknown[]> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/chats/${terminalId}/answers`);
	return ((await response.json()) as FakeAnswers).answers;
}

/** Open the workspace on the chat tab, through the API relay to the fake agent. */
async function openFakeChat(page: Page, path: string, id: string) {
	await page.goto(path);
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(view).toBeVisible({ timeout: 15_000 });
	return view;
}

/** The fake chat's scripted turn, with its cards, starts on the first message. */
async function startTurn(view: Locator, text = "Look at the project") {
	const box = view.getByTestId("chat-composer-input");
	await box.fill(text);
	await box.press("Enter");
	await expect(view.getByTestId("chat-question-card")).toBeVisible();
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`the fake chat's turn and cards, by keyboard (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme });
		const { student, project, id } = await makeChatTab(page, context);
		const remote: string[] = [];
		page.on("request", (request) => {
			if (request.url().includes("example.com/pixel.png")) remote.push(request.url());
		});
		const view = await openFakeChat(
			page,
			workspacePath(student.workspaceId, project.id),
			id,
		);

		await expect(view.getByText("Earlier answer")).toBeVisible();
		await startTurn(view);
		await expect(view.getByText("plan", { exact: true })).toHaveJSProperty(
			"tagName",
			"STRONG",
		);
		await expect(view.getByRole("link", { name: "the docs" })).toHaveAttribute(
			"rel",
			"noopener noreferrer",
		);
		await expect(view.getByTestId("chat-cards-waiting")).toHaveText(
			"1 more request is waiting.",
		);
		// The card waits for the student; the keyboard stays in the message box.
		await expect(view.getByTestId("chat-composer-input")).toBeFocused();
		await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);

		await view.getByRole("checkbox", { name: "Lint" }).focus();
		await page.keyboard.press("Space");
		await page.keyboard.press("Tab"); // Tests
		await page.keyboard.press("Tab"); // Types
		await page.keyboard.press("Space");
		await page.keyboard.press("Tab"); // Other
		await page.keyboard.type("and docs");
		await page.keyboard.press("Tab"); // Add a note
		await page.keyboard.press("Enter");
		await page.keyboard.type("quick ones");
		await page.keyboard.press("Tab"); // the layout radios
		await page.keyboard.press("ArrowDown");
		await expect(view.getByRole("radio", { name: "Tree" })).toBeChecked();
		await expect(view.getByTestId("chat-question-preview")).toHaveText(
			"|- src\n|- test",
		);
		await page.keyboard.press("Enter");

		await expect(view.getByTestId("chat-question-card")).toHaveCount(0);
		await expect(view.getByRole("button", { name: "Allow" })).toBeFocused();
		await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);
		await page.keyboard.press("Enter");
		await expect(view.getByTestId("chat-permission-card")).toHaveCount(0);

		await expect
			.poll(() => fakeAnswers(id))
			.toEqual([
				{
					type: "question.answer",
					id: "card-question",
					answers: {
						"Which checks should run?": "Lint, Types",
						"Which layout?": "Tree",
					},
					notes: { "Which checks should run?": "and docs\nquick ones" },
				},
				{ type: "permission.answer", id: "card-permission", optionId: "allow" },
			]);

		// The tool's image is drawn from the frame; the reply's remote image never loads.
		await view.getByTestId("chat-worked").locator("> summary").click();
		await view.getByTestId("chat-tool-tool-1").locator("> summary").click();
		await expect(view.getByRole("img", { name: "Output of Read" })).toBeVisible();
		expect(remote).toEqual([]);
	});
}

test("a card answered in one browser clears in the other", async ({
	page,
	context,
	browser,
}) => {
	test.setTimeout(90_000);
	const { student, project, id } = await makeChatTab(page, context);
	const path = workspacePath(student.workspaceId, project.id);
	const first = await openFakeChat(page, path, id);
	const otherContext = await browser.newContext();
	try {
		await addSession(otherContext, student.userId);
		const other = await otherContext.newPage();
		const second = await openFakeChat(other, path, id);
		await startTurn(first);
		await expect(second.getByTestId("chat-question-card")).toBeVisible();

		await first.getByRole("checkbox", { name: "Tests" }).check();
		await first.getByRole("radio", { name: "Tabs" }).check();
		await first.getByRole("button", { name: "Send answers" }).click();
		await expect(second.getByTestId("chat-question-card")).toHaveCount(0);
		await expect(second.getByTestId("chat-permission-card")).toBeVisible();

		await second.getByRole("button", { name: "Deny" }).click();
		await expect(first.getByTestId("chat-permission-card")).toHaveCount(0);
		await expect(second.getByTestId("chat-permission-card")).toHaveCount(0);
		await expect
			.poll(() => fakeAnswers(id))
			.toEqual([
				{
					type: "question.answer",
					id: "card-question",
					answers: { "Which checks should run?": "Tests", "Which layout?": "Tabs" },
				},
				{ type: "permission.answer", id: "card-permission", optionId: "deny" },
			]);
	} finally {
		await otherContext.close();
	}
});

test("typing in the message box while a card arrives keeps the keyboard there and never answers it", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	const { student, project, id } = await makeChatTab(page, context);
	const view = await openFakeChat(
		page,
		workspacePath(student.workspaceId, project.id),
		id,
	);
	const box = view.getByTestId("chat-composer-input");
	await box.click();
	await box.fill("Look at the project");
	await box.press("Enter");
	// The cards arrive while the student is still in the box.
	await expect(view.getByTestId("chat-question-card")).toBeVisible();
	await expect(box).toBeFocused();
	await page.keyboard.type("and check the tests");
	await page.keyboard.press("Enter");
	await expect(view.getByText("and check the tests")).toBeVisible();
	await expect(view.getByTestId("chat-question-card")).toBeVisible();
	expect(await fakeAnswers(id)).toEqual([]);
	await expect(view.getByTestId("chat-announcer")).toHaveText(
		"Claude has 2 questions. 1 more request is waiting.",
	);
});

test("a card whose answer was lost with the connection can be answered after the reconnect", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	const { id } = await makeChatTab(page, context);
	const answers: unknown[] = [];
	let connections = 0;
	let dropped = false;
	await page.routeWebSocket(/\/chat$/, (ws) => {
		connections += 1;
		let seq = 100 * connections;
		const send = (type: string, body: Record<string, unknown> = {}) =>
			ws.send(JSON.stringify({ type, sessionId: id, seq: seq++, ...body }));
		send("snapshot", {
			cards: [{ type: "permission", ...PERMISSION }],
			turnRunning: false,
			truncated: false,
		});
		ws.onMessage((raw) => {
			// The first answer is lost as the connection drops; the host still waits.
			if (!dropped) {
				dropped = true;
				void ws.close({ code: 4000 });
				return;
			}
			answers.push(JSON.parse(String(raw)));
			send("card.resolved", { id: "p1" });
		});
	});
	await page.reload();
	const view = page.getByTestId(`chat-view-${id}`);
	const allow = view.getByRole("button", { name: "Allow", exact: true });
	await allow.click();
	await expect(view.getByTestId("chat-connection")).toHaveText("Reconnecting…");
	await expect(view.getByTestId("chat-connection")).toHaveText("", { timeout: 15_000 });
	await expect(allow).not.toHaveAttribute("aria-busy", "true");
	await allow.click();
	await expect(view.getByTestId("chat-permission-card")).toHaveCount(0);
	expect(answers).toEqual([{ type: "permission.answer", id: "p1", optionId: "allow" }]);
});

test("Resume continues an ended chat in a new chat in its place", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	const { student, project, id } = await makeChatTab(page, context);
	await waitForSavedLeaf(project.id, id);
	await endTerminal(id);
	await page.reload();
	await expect(page.getByTestId(`terminal-ended-${id}`)).toContainText(
		"This chat ended when the workspace stopped",
	);
	const posted = page.waitForRequest(
		(request) => request.method() === "POST" && request.url().includes("/terminals"),
	);
	await page.getByRole("button", { name: "Resume chat" }).click();
	expect((await posted).postDataJSON()).toEqual({
		projectId: project.id,
		kind: "chat",
		agent: "claude",
		resumeChatOf: id,
	});
	// The ended record goes, and the new chat takes its place with the keyboard.
	await expect
		.poll(async () => terminalIds(student.workspaceId, project.id))
		.not.toContain(id);
	const [next] = await terminalIds(student.workspaceId, project.id);
	const view = page.getByTestId(`chat-view-${next}`);
	await expect(view).toBeVisible({ timeout: 15_000 });
	await expect(view.getByTestId("chat-composer-input")).toBeFocused();
	await expect(page.getByRole("tab", { name: /Claude Code \(GUI\)/ })).toHaveCount(1);
});

test("chat and terminal Claude Code tabs are told apart, and the pane matches its tab", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	const { id } = await makeChatTab(page, context);
	await page.reload();
	await expect(page.getByTestId(`chat-view-${id}`)).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-claude").click();
	await expect(page.getByRole("tab", { name: /Claude Code \(TUI\)/ })).toHaveCount(1);
	await page.getByRole("tab", { name: /Claude Code \(GUI\)/ }).click();
	await expect(page.getByTestId(`terminal-handle-${id}`)).toHaveText(
		/^Claude Code \(GUI\) · /,
	);
});

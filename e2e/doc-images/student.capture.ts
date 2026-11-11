/**
 * The student images in docs/images, from a demo workspace with the Weather
 * Now project. Each test sets up and shoots one or a few images.
 */
import {
	expect,
	type Locator,
	type Page,
	test,
	type WebSocketRoute,
} from "@playwright/test";
import { query, setWorkspaceState } from "../helpers";
import {
	course,
	flaskRunning,
	homeFull,
	inHours,
	launch,
	minutesAgo,
	openProject,
	otherProjects,
	person,
	printTo,
	saveLayout,
	servePreview,
	setAgentTabs,
	setPlans,
	shoot,
	weatherProject,
} from "./seed";

const SCHEMES = ["light", "dark"] as const;

/** The dark shot of an image is named like the light one with `-dark` added. */
function imageName(base: string, colorScheme: (typeof SCHEMES)[number]) {
	return colorScheme === "light" ? `${base}.png` : `${base}-dark.png`;
}

const PROMPT = "student@ws-maya:~/projects/weather-now$";

const PYTEST = [
	`${PROMPT} pytest -q`,
	"..........                                                    [100%]",
	"10 passed in 0.41s",
	`${PROMPT} flask --app app run --host 0.0.0.0`,
	" * Serving Flask app 'app'",
	" * Debug mode: off",
	" * Running on all addresses (0.0.0.0)",
	" * Running on http://127.0.0.1:5000",
	"Press CTRL+C to quit",
	'127.0.0.1 - - [10/Nov/2026 10:42:07] "GET /?city=Columbus HTTP/1.1" 200 -',
	'127.0.0.1 - - [10/Nov/2026 10:42:31] "GET /static/style.css HTTP/1.1" 200 -',
];

/** Maya's workspace with the weather project open, a shell and two agents. */
async function workspace(page: Page, colorScheme: "light" | "dark" = "light") {
	await page.emulateMedia({ colorScheme });
	const maya = await person("Maya Chen", "maya", { context: page.context() });
	await otherProjects(maya.workspaceId);
	const project = await weatherProject(maya.workspaceId);
	// Every running workspace shot shows the plan meters beside Memory and Disk.
	await weeklyPlans(maya.workspaceId);
	return { maya, project };
}

/** The agents' hooks: a TUI agent with two subagents, a chat waiting, a Codex done. */
async function agents(workspaceId: string, ids: { tui: string; chat?: string }) {
	await setAgentTabs(workspaceId, [
		{
			terminalId: ids.tui,
			agent: "claude",
			state: "working",
			since: minutesAgo(3),
			subagents: [
				{
					id: "toolu_explore",
					type: "Explore",
					description: "Find where the forecast is parsed",
					state: "working",
				},
				{
					id: "toolu_tests",
					type: "general-purpose",
					description: "Write tests for find_city",
					state: "finished",
				},
			],
		},
		...(ids.chat
			? [
					{
						terminalId: ids.chat,
						agent: "claude" as const,
						state: "needs-input" as const,
					},
				]
			: []),
	]);
	await weeklyPlans(workspaceId);
}

/** Each agent's weekly plan use, as the status line reports it (SPEC.md §10.8). */
function weeklyPlans(workspaceId: string) {
	return setPlans(workspaceId, [
		{ id: "claude", label: "Claude", usedPercent: 42, resetsAt: inHours(70) },
		{ id: "codex", label: "Codex", usedPercent: 17, resetsAt: inHours(118) },
	]);
}

/**
 * The host's `context` report in a 200k window, and a one-hour cache read 12
 * minutes ago. The chat capture shows a high step of the meter and the
 * composer capture a low one.
 */
function sendContext(send: Send, usedTokens: number) {
	send("context", {
		usedTokens,
		windowTokens: 200_000,
		cache: { at: Date.now() - 12 * 60_000, ttlSeconds: 3600 },
		now: Date.now(),
	});
}

for (const colorScheme of SCHEMES) {
	test(`workspace shell (${colorScheme})`, async ({ page }) => {
		const { maya, project } = await workspace(page, colorScheme);
		await agents(maya.workspaceId, { tui: "none" });
		await openProject(page, maya.workspaceId, project.id);
		const shell = await launch(page, maya.workspaceId, project.id, "terminal");
		const tui = await launch(page, maya.workspaceId, project.id, "claude");
		const chat = await launch(page, maya.workspaceId, project.id, "claude-gui");
		await agents(maya.workspaceId, { tui, chat });
		await page.getByRole("tab", { name: "Terminal 1" }).click();
		await expect(page.getByTestId(`terminal-pane-${shell}`)).toHaveAttribute(
			"data-connected",
			"true",
			{ timeout: 15_000 },
		);
		await printTo(shell, PYTEST);
		await expect(page.getByTestId(`project-agents-${project.id}`)).toBeVisible();
		await expect(page.getByTestId("agent-meter-claude")).toBeVisible();
		await shoot(page, imageName("student-shell", colorScheme));
		if (colorScheme === "light") {
			await shoot(page, "student-agent-rows.png", {
				clip: { x: 0, y: 0, width: 720, height: 400 },
			});
			// The needs-input toast, when it has appeared, sits over the status bar
			// and would take the click; it does not always appear in time.
			const dismiss = page
				.getByRole("region", { name: /Notifications/ })
				.getByRole("button", { name: "Dismiss" })
				.first();
			if (await dismiss.isVisible()) await dismiss.click();
			// The keyboard opens it even if a late toast covers the button.
			await page.getByTestId("agent-meter-claude").press("Enter");
			await expect(page.getByTestId("agent-meter-claude-details")).toBeVisible();
			await shoot(page, "student-agent-meter.png", {
				clip: { x: 720, y: 600, width: 720, height: 300 },
			});
			await page.keyboard.press("Escape");
			await page.getByTestId("launcher").click();
			await expect(page.getByTestId("launcher-claude-gui")).toBeVisible();
			await shoot(page, "student-new-tab-menu.png");
		}
	});
}

type Send = (type: string, body?: Record<string, unknown>) => void;

/** Answer the chat socket with a script standing in for the host. */
async function scriptChat(page: Page, id: string, play: (send: Send) => void) {
	await page.routeWebSocket(/\/chat$/, (ws: WebSocketRoute) => {
		let seq = 0;
		const send: Send = (type, body = {}) =>
			ws.send(JSON.stringify({ type, sessionId: id, seq: seq++, ...body }));
		play(send);
	});
	await page.reload();
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(view.getByTestId("composer-model")).toBeAttached({ timeout: 20_000 });
	return view;
}

/** The composer's context meter and the status bar's plan meters are both up. */
async function expectMeters(page: Page, view: Locator, figures: string) {
	await expect(view.getByTestId("composer-context")).toContainText(figures);
	await expect(page.getByTestId("agent-meter-claude")).toBeVisible();
	await expect(page.getByTestId("agent-meter-codex")).toBeVisible();
}

const SETTINGS = { agent: "claude", model: "opus", effort: "medium", mode: "auto" };

/** Claude Code's model list, as the host sends it before the settings. */
const MODELS = [
	["default", "Default (recommended)", "claude-opus-5-5"],
	["opus", "Opus 5.5", "claude-opus-5-5"],
	["sonnet", "Sonnet 5.5", "claude-sonnet-5-5"],
	["haiku", "Haiku 5.5", "claude-haiku-5-5"],
	["claude-opus-4-8", "Opus 4.8", "claude-opus-4-8"],
].map(([value, displayName, resolvedModel]) => ({
	value,
	displayName,
	resolvedModel,
	description: displayName,
	supportsAutoMode: true,
}));

for (const colorScheme of SCHEMES) {
	test(`chat (${colorScheme})`, async ({ page }) => {
		const { maya, project } = await workspace(page, colorScheme);
		await weeklyPlans(maya.workspaceId);
		await openProject(page, maya.workspaceId, project.id);
		const id = await launch(page, maya.workspaceId, project.id, "claude-gui");
		const at = Date.now() - 90_000;
		const view = await scriptChat(page, id, (send) => {
			send("snapshot", {
				cards: [
					{
						type: "permission",
						id: "p1",
						toolName: "Bash",
						title: "Run the tests",
						input: { command: "pytest -q", description: "Run the tests" },
						options: [
							{ id: "allow", label: "Allow once" },
							{ id: "always", label: 'Always allow "pytest" commands in this session' },
							{ id: "deny", label: "Deny" },
						],
					},
				],
				turnRunning: true,
				truncated: false,
			});
			send("turn.started", { at });
			send("message", {
				id: "u1",
				role: "user",
				markdown:
					"When the city is not found the page crashes. Can you show a friendly message instead, and add a test for it?",
			});
			send("message", {
				id: "a1",
				role: "assistant",
				markdown:
					"I'll look at how `index()` handles the geocoding result, then add the message and a test.",
			});
			send("tool.started", {
				id: "t1",
				name: "Read",
				title: "Read a file",
				input: { file_path: "app.py" },
			});
			send("tool.output", { id: "t1", part: { type: "text", text: "61 lines" } });
			send("tool.finished", { id: "t1", isError: false });
			send("tool.started", {
				id: "t2",
				name: "Read",
				title: "Read a file",
				input: { file_path: "templates/index.html" },
			});
			send("tool.finished", { id: "t2", isError: false });
			send("tool.started", {
				id: "t3",
				name: "Edit",
				title: "Edit a file",
				input: {
					file_path: "app.py",
					old_string: "    place = find_city(city)\n    hourly = forecast(*place)",
					new_string:
						'    place = find_city(city)\n    if place is None:\n        return render_template("index.html", city=city, hours=[], missing=True)\n    hourly = forecast(*place)',
				},
			});
			send("tool.finished", { id: "t3", isError: false });
			send("tool.started", {
				id: "t4",
				name: "Write",
				title: "Write a file",
				input: { file_path: "tests/test_app.py", content: "..." },
			});
			send("tool.finished", { id: "t4", isError: false });
			send("message", {
				id: "a2",
				role: "assistant",
				markdown:
					"`find_city` now returns `None` for an unknown city, and the page says **No city called …** instead of crashing. I added `test_unknown_city_says_so`. Next I'd like to run the tests.",
			});
			send("permission.requested", {
				id: "p1",
				toolName: "Bash",
				title: "Run the tests",
				input: { command: "pytest -q", description: "Run the tests" },
				options: [
					{ id: "allow", label: "Allow once" },
					{ id: "always", label: 'Always allow "pytest" commands in this session' },
					{ id: "deny", label: "Deny" },
				],
			});
			send("models", { models: MODELS });
			send("settings", SETTINGS);
			sendContext(send, 166_000);
		});
		await expect(view.getByTestId("chat-permission-card")).toBeVisible();
		await expectMeters(page, view, "166k / 200k");
		await view.getByText("4 tool calls").click();
		await shoot(page, imageName("student-chat", colorScheme));
	});
}

for (const colorScheme of SCHEMES) {
	test(`chat composer and shell command (${colorScheme})`, async ({ page }) => {
		const { maya, project } = await workspace(page, colorScheme);
		await weeklyPlans(maya.workspaceId);
		await openProject(page, maya.workspaceId, project.id);
		const id = await launch(page, maya.workspaceId, project.id, "claude-gui");
		const view = await scriptChat(page, id, (send) => {
			send("snapshot", { cards: [], turnRunning: false, truncated: false });
			send("message", {
				id: "u1",
				role: "user",
				markdown: "What does `forecast()` ask the API for?",
			});
			send("message", {
				id: "a1",
				role: "assistant",
				markdown:
					"It asks Open-Meteo for one day of **hourly** data: the temperature at 2 m (`temperature_2m`) and the chance of rain (`precipitation_probability`), for the latitude and longitude `find_city` found.",
			});
			send("shell", {
				id: "sh1",
				command: "pip list | grep -i flask",
				output: "Flask        3.1.2\n",
				exitCode: 0,
				truncated: false,
				state: "done",
			});
			send("shell", {
				id: "sh2",
				command: "python -m pytest -q tests",
				output:
					"..........                                   [100%]\n10 passed in 0.41s\n",
				exitCode: 0,
				truncated: false,
				state: "done",
			});
			send("models", { models: MODELS });
			send("settings", SETTINGS);
			send("commands", {
				commands: [
					{
						name: "compact",
						description: "Summarise the conversation so far",
						argumentHint: "[focus]",
						terminalOnly: false,
					},
					{
						name: "clear",
						description: "Start a new conversation",
						terminalOnly: false,
					},
					{ name: "review", description: "Review a pull request", terminalOnly: false },
					{
						name: "init",
						description: "Write a CLAUDE.md for this project",
						terminalOnly: false,
					},
					{ name: "model", description: "Choose the model", terminalOnly: true },
				],
			});
			sendContext(send, 34_200);
		});
		await expect(view.getByTestId("chat-shell").first()).toBeVisible();
		await expectMeters(page, view, "34.2k / 200k");
		if (colorScheme === "light") await shoot(page, "student-chat-shell.png");
		await view.getByTestId("chat-composer-input").click();
		await page.keyboard.type("/");
		await expect(view.getByRole("listbox", { name: "Commands" })).toBeVisible();
		await shoot(page, imageName("student-chat-composer", colorScheme));
	});
}

const APP_TAB = {
	tabs: [{ id: "file:app.py", root: { type: "file", path: "app.py" } }],
};

test("checks", async ({ page }) => {
	const { maya, project } = await workspace(page);
	await saveLayout(project.id, APP_TAB);
	await openProject(page, maya.workspaceId, project.id);
	await page.getByTestId("right-pane-tab-checks").click();
	await page.getByTestId("check-run-tests").click();
	await expect(page.getByTestId("check-state-tests")).toContainText(/Passed/, {
		timeout: 20_000,
	});
	await shoot(page, "student-checks.png");
});

for (const colorScheme of SCHEMES) {
	test(`new project (${colorScheme})`, async ({ page }) => {
		const { maya, project } = await workspace(page, colorScheme);
		await openProject(page, maya.workspaceId, project.id);
		await page.getByTestId("new-project").click();
		await page.getByRole("menuitem", { name: "New project" }).click();
		await expect(page.getByTestId("dialog-create-project")).toBeVisible();
		await page.getByTestId("field-name").fill("Budget Tracker");
		await expect(page.getByTestId("agent-meter-codex")).toBeVisible();
		await shoot(page, imageName("student-new-project", colorScheme));
	});
}

for (const colorScheme of SCHEMES) {
	test(`settings (${colorScheme})`, async ({ page }) => {
		const { maya, project } = await workspace(page, colorScheme);
		await openProject(page, maya.workspaceId, project.id);
		await page.getByTestId("me").click();
		await page.getByRole("menuitem", { name: "Settings" }).click();
		await expect(page.getByTestId("dialog-editor-settings")).toBeVisible();
		await expect(page.getByTestId("agent-meter-codex")).toBeVisible();
		await shoot(page, imageName("student-settings", colorScheme));
	});
}

test("running preview", async ({ page }) => {
	const { maya, project } = await workspace(page);
	await servePreview(page);
	await flaskRunning(maya.workspaceId);
	await openProject(page, maya.workspaceId, project.id);
	await page.getByTestId("right-pane-tab-running").click();
	await page.getByTestId("running-open-5000").click({ timeout: 20_000 });
	await expect(
		page.frameLocator("[data-testid=preview-frame]").locator("h1"),
	).toHaveText("Weather in Columbus", { timeout: 20_000 });
	await page.getByTestId("running-row-5000").click();
	await shoot(page, "student-running-preview.png");
});

for (const colorScheme of SCHEMES) {
	test(`starting and error (${colorScheme})`, async ({ page }) => {
		const { maya, project } = await workspace(page, colorScheme);
		await setWorkspaceState(maya.workspaceId, "starting");
		await page.goto(`/workspaces/${maya.workspaceId}/projects/${project.id}`);
		await page.waitForTimeout(1500);
		await shoot(page, imageName("student-starting", colorScheme));
		await homeFull(maya.workspaceId);
		await query(
			`update workspaces set state = 'error', error_code = 'STORAGE_FULL',
		 error_message = 'Your workspace could not start because its storage is full.' where id = $1`,
			[maya.workspaceId],
		);
		await page.reload();
		await page.waitForTimeout(1500);
		await shoot(page, imageName("student-error", colorScheme));
	});
}

test("help", async ({ page }) => {
	await person("Maya Chen", "maya", { context: page.context() });
	await page.goto("/help");
	await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
	await shoot(page, "help-page.png");
});

/** Rewrite what the scripted language server answers, so the shots read like pyright. */
async function realisticCodeHelp(page: Page) {
	await page.routeWebSocket(/\/language-servers\//, (route) => {
		const server = route.connectToServer();
		const asked = new Map<unknown, string>();
		route.onMessage((data) => {
			try {
				const message = JSON.parse(String(data));
				if (message.id !== undefined && message.method)
					asked.set(message.id, message.method);
			} catch {}
			server.send(data);
		});
		server.onMessage((data) => {
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(String(data));
			} catch {
				route.send(data);
				return;
			}
			const method = message.method ?? asked.get(message.id);
			if (method === "textDocument/hover") {
				message.result = {
					contents: {
						kind: "markdown",
						value:
							"```python\n(function) def find_city(name: str) -> tuple[float, float] | None\n```\n---\nReturn the latitude and longitude of the first match, or None.",
					},
				};
			} else if (method === "textDocument/diagnostic") {
				message.result = { kind: "full", items: DIAGNOSTICS };
			} else if (method === "textDocument/publishDiagnostics") {
				(message.params as { diagnostics: unknown }).diagnostics = DIAGNOSTICS;
			}
			route.send(JSON.stringify(message));
		});
	});
}

const DIAGNOSTICS = [
	{
		range: { start: { line: 47, character: 4 }, end: { line: 47, character: 9 } },
		severity: 2,
		source: "Pyright",
		message: 'Type of "hours" is partially unknown',
	},
	{
		range: { start: { line: 22, character: 13 }, end: { line: 22, character: 21 } },
		severity: 3,
		source: "Ruff",
		message: "ANN001 Missing type annotation for function argument `latitude`",
	},
];

const EDITOR_TABS = {
	tabs: [
		{ id: "file:app.py", root: { type: "file", path: "app.py" } },
		{ id: "file:README.md", root: { type: "file", path: "README.md" } },
	],
};

for (const colorScheme of SCHEMES) {
	test(`editor and code help (${colorScheme})`, async ({ page }) => {
		const { maya, project } = await workspace(page, colorScheme);
		await realisticCodeHelp(page);
		await saveLayout(project.id, EDITOR_TABS);
		await openProject(page, maya.workspaceId, project.id);
		await page.getByRole("tab", { name: "app.py" }).click();
		const editor = page.getByTestId("editor-app.py");
		await expect(editor.locator(".view-lines")).toContainText("find_city", {
			timeout: 20_000,
		});
		await expect(page.getByTestId("editor-code-help-app.py")).toBeVisible();
		await expect(page.getByTestId("agent-meter-codex")).toBeVisible();
		await page.waitForTimeout(2000);
		await shoot(page, imageName("student-editor", colorScheme));
		if (colorScheme === "dark") return;

		await page.getByTestId("right-pane-tab-problems").click();
		await editor
			.locator(".view-line span span", { hasText: "find_city" })
			.last()
			.hover();
		await expect(page.locator(".monaco-hover:not(.hidden)").first()).toContainText(
			"latitude and longitude",
		);
		await shoot(page, "student-code-help.png", { keepMouse: true });
	});
}

test("live help, student side", async ({ page }) => {
	const { maya, project } = await workspace(page);
	const ivy = await person("Dr. Ivy Okafor", "okafor", { role: "instructor" });
	await course("CS 1210: Programming for the Web", ivy.userId, [maya.userId]);
	await openProject(page, maya.workspaceId, project.id);
	const shell = await launch(page, maya.workspaceId, project.id, "terminal");
	await expect(page.getByTestId(`terminal-pane-${shell}`)).toHaveAttribute(
		"data-connected",
		"true",
		{ timeout: 15_000 },
	);
	await printTo(shell, [
		`${PROMPT} flask --app app run`,
		"Traceback (most recent call last):",
		'  File "/home/student/projects/weather-now/app.py", line 4, in <module>',
		"    import requests",
		"ModuleNotFoundError: No module named 'requests'",
		PROMPT,
	]);
	await page.getByTestId(`project-menu-${project.id}`).click();
	await page.getByRole("menuitem", { name: "Get live help…" }).click();
	const dialog = page.getByTestId("dialog-live-help");
	await dialog.getByTestId("live-help-start").click();
	await expect(page.getByTestId("live-help-bar")).toBeVisible();
	await page.getByTestId(`terminal-pane-${shell}`).click();
	await shoot(page, "student-live-help.png");
});

for (const colorScheme of SCHEMES) {
	test(`phone (${colorScheme})`, async ({ browser }) => {
		const context = await browser.newContext({
			viewport: { width: 390, height: 844 },
			hasTouch: true,
			isMobile: true,
			deviceScaleFactor: 1,
		});
		const page = await context.newPage();
		const { maya, project } = await workspace(page, colorScheme);
		await openProject(page, maya.workspaceId, project.id);
		const tui = await launch(page, maya.workspaceId, project.id, "claude");
		await agents(maya.workspaceId, { tui });
		await page.getByRole("button", { name: "Projects", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "Projects" })).toBeVisible();
		await expect(page.getByTestId(`project-agents-${project.id}`)).toBeVisible();
		await shoot(page, imageName("student-phone", colorScheme));
		await context.close();
	});
}

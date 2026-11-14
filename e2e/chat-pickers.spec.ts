import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	launchChat,
	openChat,
	openChatOptions,
	receivedFrames,
	scriptedChat,
} from "./chat-helpers";
import {
	createProject,
	createStudent,
	expectNoViolations,
	query,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";

/**
 * The composer's agent, model, effort and permission pickers (SPEC.md
 * §8.3, §10.8, §25.8), against the fake agent's chat through the API
 * relay. Each is a menu button with a radio menu; the fake answers every
 * set with the settings it now holds.
 */

const TEST_ID: Record<string, string> = {
	Agent: "composer-agent",
	Model: "composer-model",
	Effort: "composer-effort",
	Permissions: "composer-mode",
};

/** By test id: an open menu hides the rest of the page from role queries. */
function picker(view: Locator, label: string): Locator {
	return view.getByTestId(TEST_ID[label] ?? label);
}

/**
 * A chat from the New tab menu, once its pickers have the host's first
 * settings, with the Chat options panel that holds them open.
 */
async function withPickers<T extends { view: Locator }>(
	opening: Promise<T>,
): Promise<T> {
	const chat = await opening;
	await expect(picker(chat.view, "Model")).toBeAttached({ timeout: 15_000 });
	await openChatOptions(chat.view);
	return chat;
}

function menu(page: Page, label: string): Locator {
	return page.getByRole("menu", { name: new RegExp(`^${label} `) });
}

async function choose(page: Page, view: Locator, label: string, option: string) {
	await picker(view, label).click();
	await menu(page, label).getByRole("menuitemradio", { name: option }).click();
	await expect(menu(page, label)).toHaveCount(0);
}

test("each picker sends its set and shows what the host reports", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { id, view } = await withPickers(
		openChat(page, student.workspaceId, "Pickers"),
	);
	// Each is a button named by its visible label and the value shown.
	for (const [label, value] of [
		["Agent", "Claude Code"],
		["Model", "Sonnet"],
		["Effort", "Medium"],
		["Permissions", "Ask"],
	]) {
		await expect(view.getByRole("button", { name: `${label} ${value}` })).toBeVisible();
	}

	await choose(page, view, "Model", "Opus");
	await expect(picker(view, "Model")).toHaveText("Model Opus");
	await choose(page, view, "Effort", "Extra high");
	await expect(picker(view, "Effort")).toHaveText("Effort Extra high");
	await choose(page, view, "Permissions", "Bypass permissions");
	await expect(picker(view, "Permissions")).toHaveText(
		"Permissions Bypass permissions",
	);
	await expect(view.getByTestId("chat-bypass-warning")).toContainText(
		"without asking you first",
	);
	await expect(view.getByTestId("chat-composer-status")).toContainText(
		"Bypass permissions is on.",
	);
	await expect
		.poll(async () => receivedFrames(id, "set"))
		.toEqual([
			{ type: "set", model: "opus" },
			{ type: "set", effort: "xhigh" },
			{ type: "set", mode: "bypassPermissions" },
		]);

	// Choosing the value already shown sends nothing more.
	await choose(page, view, "Model", "Opus");
	await choose(page, view, "Permissions", "Plan");
	await expect(picker(view, "Permissions")).toHaveText("Permissions Plan");
	await expect(view.getByTestId("chat-bypass-warning")).toHaveCount(0);
	await expect.poll(async () => (await receivedFrames(id, "set")).length).toBe(4);
});

test("each menu marks the current and the default value and says what every choice is for", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { view } = await withPickers(openChat(page, student.workspaceId, "Pickers"));

	await picker(view, "Permissions").click();
	const modes = menu(page, "Permissions");
	// The start value is marked "Default" in its description, not its name.
	const ask = modes.getByRole("menuitemradio", { name: "Ask", exact: true });
	await expect(ask).toHaveAttribute("aria-checked", "true");
	await expect(ask).toHaveAccessibleDescription(/^Asks before/);
	const auto = modes.getByRole("menuitemradio", { name: "Auto", exact: true });
	await expect(auto).toHaveAttribute("aria-checked", "false");
	await expect(auto).toHaveAccessibleDescription(/^Default\. Runs what it judges safe/);
	// The warning is in the menu before Bypass is chosen.
	const bypass = modes.getByRole("menuitemradio", { name: "Bypass permissions" });
	await expect(bypass).toHaveAttribute("aria-checked", "false");
	await expect(bypass).toHaveAccessibleDescription(
		"Bypass permissions lets Claude run every tool without asking you first.",
	);
	await expect(bypass.locator("svg[data-icon='alert']")).toBeVisible();
	await page.keyboard.press("Escape");

	await picker(view, "Effort").click();
	const efforts = menu(page, "Effort");
	await expect(efforts.getByRole("menuitemradio")).toHaveCount(5);
	await expect(
		efforts.getByRole("menuitemradio", { name: "High", exact: true }),
	).toHaveAttribute("aria-checked", "false");
	// Medium is both the current value and the start value.
	const medium = efforts.getByRole("menuitemradio", { name: "Medium" });
	await expect(medium).toHaveAttribute("aria-checked", "true");
	await expect(medium).toHaveAccessibleDescription(/^Default\. Thinks a little/);
	for (const item of await efforts.getByRole("menuitemradio").all()) {
		await expect(item).toHaveAccessibleDescription(/\w{4,}/);
	}
	await page.keyboard.press("Escape");

	await picker(view, "Agent").click();
	const codex = menu(page, "Agent").getByRole("menuitemradio", { name: "Codex" });
	await expect(codex).toHaveAttribute("aria-disabled", "true");
	await expect(codex).toHaveAccessibleDescription("Coming soon.");
	// Playwright will not click an aria-disabled item, so press it.
	await codex.focus();
	await page.keyboard.press("Enter");
	// Nothing to choose: the menu stays open on Claude Code.
	await expect(menu(page, "Agent")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(picker(view, "Agent")).toHaveText("Agent Claude Code");
});

test("the pickers work from the keyboard alone", async ({ page, context }) => {
	const student = await createStudent(context);
	const { id, view } = await withPickers(
		openChat(page, student.workspaceId, "Pickers"),
	);
	const model = picker(view, "Model");
	await model.focus();
	await expect(model).toHaveAttribute("aria-haspopup", "menu");
	await expect(model).toHaveAttribute("aria-expanded", "false");

	await page.keyboard.press("Enter");
	const models = menu(page, "Model");
	await expect(model).toHaveAttribute("aria-expanded", "true");
	const item = (name: string) => models.getByRole("menuitemradio", { name });
	await expect(item("Default")).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(item("Opus")).toBeFocused();
	await page.keyboard.press("End");
	await expect(item("Haiku")).toBeFocused();
	await page.keyboard.press("Home");
	await expect(item("Default")).toBeFocused();
	await page.keyboard.press("s");
	await expect(item("Sonnet")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(models).toHaveCount(0);
	await expect(model).toBeFocused();
	await expect(model).toHaveAttribute("aria-expanded", "false");

	await page.keyboard.press("ArrowDown");
	await expect(item("Default")).toBeFocused();
	await page.keyboard.press("h");
	await expect(item("Haiku")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(models).toHaveCount(0);
	await expect(model).toBeFocused();
	await expect(model).toHaveText("Model Haiku");
	await expect
		.poll(async () => receivedFrames(id, "set"))
		.toEqual([{ type: "set", model: "haiku" }]);

	// The unavailable choice is reached, not skipped.
	await picker(view, "Agent").focus();
	await page.keyboard.press("Enter");
	await page.keyboard.press("ArrowDown");
	await expect(
		menu(page, "Agent").getByRole("menuitemradio", { name: "Codex" }),
	).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(picker(view, "Agent")).toBeFocused();
});

test("a menu opens attached to its button and inside the window, wide or narrow", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { view } = await withPickers(openChat(page, student.workspaceId, "Pickers"));
	for (const width of [1280, 360]) {
		await page.setViewportSize({ width, height: 800 });
		const button = picker(view, "Permissions");
		await button.click();
		const open = menu(page, "Permissions");
		await expect(open).toBeVisible();
		const b = await button.boundingBox();
		const m = await open.boundingBox();
		if (!b || !m) throw new Error("no layout");
		// Directly above or below the button, a small gap apart.
		const gap = Math.min(
			Math.abs(b.y - (m.y + m.height)),
			Math.abs(m.y - (b.y + b.height)),
		);
		expect(gap).toBeLessThanOrEqual(6);
		// Overlapping the button sideways, and fully inside the window.
		expect(m.x).toBeLessThan(b.x + b.width);
		expect(m.x + m.width).toBeGreaterThan(b.x);
		expect(m.x).toBeGreaterThanOrEqual(0);
		expect(m.x + m.width).toBeLessThanOrEqual(width);
		await page.keyboard.press("Escape");
		await expect(open).toHaveCount(0);
	}
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`the pickers and their menus have no accessibility violations (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const student = await createStudent(context);
		const { view } = await withPickers(openChat(page, student.workspaceId, "Pickers"));
		await choose(page, view, "Permissions", "Bypass permissions");
		await choose(page, view, "Effort", "Low");
		await expectNoViolations(page, '[data-testid="composer-picks"]');

		// Open, with the warning choice highlighted, the hardest case for contrast.
		await picker(view, "Permissions").click();
		const modes = menu(page, "Permissions");
		await modes.getByRole("menuitemradio", { name: "Plan" }).hover();
		await expectNoViolations(page, '[role="menu"]');
		await modes.getByRole("menuitemradio", { name: "Bypass permissions" }).hover();
		await expectNoViolations(page, '[role="menu"]');
		await page.keyboard.press("Escape");

		await picker(view, "Agent").click();
		await expectNoViolations(page, '[role="menu"]');
	});
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`in a narrow composer each menu has a visible heading and focus returns without a tooltip (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		await page.setViewportSize({ width: 420, height: 900 });
		const student = await createStudent(context);
		const { view } = await withPickers(openChat(page, student.workspaceId, "Pickers"));
		for (const label of Object.keys(TEST_ID)) {
			await picker(view, label).focus();
			await page.keyboard.press("Enter");
			const open = menu(page, label);
			// The heading names what the menu sets, for a touch user who never saw the tooltip.
			const heading = open.getByText(label, { exact: true });
			await expect(heading).toBeVisible();
			await expect(heading).toHaveCount(1);
			await expectNoViolations(page, '[role="menu"]');
			await page.keyboard.press("Escape");
			await expect(open).toHaveCount(0);
			await expect(picker(view, label)).toBeFocused();
			// Focus a menu hands back does not pop the name up over its neighbour.
			await expect(page.locator(".pk-tooltip")).toHaveCount(0);
		}
	});
}

/** Claude Code's own list, as the host sends it: families first, then pinned versions. */
const row = (
	value: string,
	displayName: string,
	resolvedModel = value,
	supportsAutoMode = true,
) => ({ value, displayName, resolvedModel, description: "A model", supportsAutoMode });

const MODELS = [
	row("default", "Default (recommended)", "claude-opus-5-5"),
	row("opus", "Opus 5.5", "claude-opus-5-5"),
	row("fable", "Fable 5.2", "claude-fable-5-2"),
	row("sonnet", "Sonnet 5.5", "claude-sonnet-5-5"),
	row("claude-opus-5", "Opus 5"),
	row("claude-opus-4-8", "Opus 4.8"),
	row("claude-opus-4-7", "Opus 4.7"),
];

/** A host whose chat is in Ask, where the session-rules hint shows. */
const ASK_START = { model: "opus", effort: "medium", mode: "default" };

const RULE = { rule: "Bash(sed:*)", description: '"sed" commands in this session' };

/**
 * Stand in for the host on every chat socket of the page: each chat starts
 * new, at the host's start values, and answers a set with what it now holds.
 * `rules` are reported as held from the start.
 */
async function scriptHost(
	page: Page,
	rules: (typeof RULE)[] = [],
	{
		models = MODELS,
		start = { model: "opus", effort: "medium", mode: "auto" },
	}: { models?: typeof MODELS; start?: Record<string, string> } = {},
) {
	const held = new Map<string, Record<string, string>>();
	const received = new Map<string, Record<string, unknown>[]>();
	await page.routeWebSocket(/\/chat$/, (ws) => {
		const tid = /\/terminals\/([^/]+)\/chat$/.exec(ws.url())?.[1] ?? "";
		const send = scriptedChat(ws, tid);
		const settings = held.get(tid) ?? { ...start };
		held.set(tid, settings);
		send("snapshot", { cards: [], turnRunning: false, truncated: false });
		send("models", { models });
		send("settings", { agent: "claude", ...settings });
		send("rules", { rules });
		ws.onMessage((raw) => {
			const message = JSON.parse(String(raw)) as Record<string, unknown>;
			received.set(tid, [...(received.get(tid) ?? []), message]);
			if (message.type !== "set") return;
			for (const key of ["model", "effort", "mode"]) {
				const value = message[key];
				if (typeof value === "string") settings[key] = value;
			}
			send("settings", { agent: "claude", ...settings });
		});
	});
	return { received: (tid: string) => received.get(tid) ?? [] };
}

async function expectShown(view: Locator, model: string, effort: string, mode: string) {
	await expect(picker(view, "Model")).toHaveText(`Model ${model}`);
	await expect(picker(view, "Effort")).toHaveText(`Effort ${effort}`);
	await expect(picker(view, "Permissions")).toHaveText(`Permissions ${mode}`);
}

async function openProject(page: Page, workspaceId: string, projectId: string) {
	await page.goto(workspacePath(workspaceId, projectId));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
}

test("a new chat starts with the settings last used in its project, Bypass as Auto", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	const student = await createStudent(context);
	const first = await createProject(student.workspaceId, { name: "Sticky one" });
	const second = await createProject(student.workspaceId, { name: "Sticky two" });
	const host = await scriptHost(page);

	await openProject(page, student.workspaceId, first.id);
	const used = await withPickers(launchChat(page, student.workspaceId, first.id));
	await expectShown(used.view, "Opus", "Medium", "Auto");
	await choose(page, used.view, "Model", "Sonnet");
	await choose(page, used.view, "Permissions", "Bypass permissions");
	await expectShown(used.view, "Sonnet", "Medium", "Bypass permissions");
	// Kept on the server for this project, Bypass already as Auto.
	await expect
		.poll(async () => {
			const [row] = await query<{ chat_settings: unknown }>(
				"select chat_settings from projects where id = $1",
				[first.id],
			);
			return row?.chat_settings;
		})
		.toEqual({ model: "sonnet", effort: "medium", mode: "auto", readAloud: false });

	const next = await withPickers(launchChat(page, student.workspaceId, first.id));
	await expectShown(next.view, "Sonnet", "Medium", "Auto");
	expect(host.received(next.id)).toEqual([{ type: "set", model: "sonnet" }]);

	await openProject(page, student.workspaceId, second.id);
	const other = await withPickers(launchChat(page, student.workspaceId, second.id));
	await expectShown(other.view, "Opus", "Medium", "Auto");
	expect(host.received(other.id)).toEqual([]);
});

test("a changed effort carries over to the next new chat too", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Sticky effort" });
	await scriptHost(page);
	await openProject(page, student.workspaceId, project.id);
	const used = await withPickers(launchChat(page, student.workspaceId, project.id));
	await choose(page, used.view, "Effort", "Low");
	await choose(page, used.view, "Permissions", "Plan");
	await expect
		.poll(async () => {
			const [row] = await query<{ chat_settings: unknown }>(
				"select chat_settings from projects where id = $1",
				[project.id],
			);
			return row?.chat_settings;
		})
		.toEqual({ model: "opus", effort: "low", mode: "plan", readAloud: false });
	const next = await withPickers(launchChat(page, student.workspaceId, project.id));
	await expectShown(next.view, "Opus", "Low", "Plan");
});

test("Ask says when session rules let some actions run without asking", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Ask hint" });
	await scriptHost(page, [RULE], { start: ASK_START });
	await openProject(page, student.workspaceId, project.id);
	const { view } = await withPickers(launchChat(page, student.workspaceId, project.id));
	const hint = view.getByTestId("composer-ask-hint");
	await expect(hint).toContainText(
		"Some actions are allowed without asking in this session.",
	);
	await expect(picker(view, "Permissions")).toHaveAccessibleDescription(
		/allowed without asking/,
	);
	await choose(page, view, "Permissions", "Auto");
	await expect(hint).toHaveCount(0);
	await choose(page, view, "Permissions", "Ask");
	await expect(hint).toBeVisible();
});

test("Ask shows no hint while the session holds no rules", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "No hint" });
	await scriptHost(page, [], { start: ASK_START });
	await openProject(page, student.workspaceId, project.id);
	const { view } = await withPickers(launchChat(page, student.workspaceId, project.id));
	await expect(picker(view, "Permissions")).toHaveText("Permissions Ask");
	await expect(view.getByTestId("composer-ask-hint")).toHaveCount(0);
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Ask hint has no accessibility violations (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Hint axe" });
		await scriptHost(page, [RULE], { start: ASK_START });
		await openProject(page, student.workspaceId, project.id);
		const { view } = await withPickers(
			launchChat(page, student.workspaceId, project.id),
		);
		await expect(view.getByTestId("composer-ask-hint")).toBeVisible();
		await expectNoViolations(page, '[data-testid="composer-picks"]');
	});
}

test("the Version picker defaults to Latest and names the version it means", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Version" });
	await scriptHost(page);
	await openProject(page, student.workspaceId, project.id);
	const { view } = await withPickers(launchChat(page, student.workspaceId, project.id));
	await expect(picker(view, "Model")).toHaveText("Model Opus");
	await expect(view.getByTestId("composer-version")).toHaveText("Version Latest (5.5)");
	await expect(view.getByTestId("composer-options")).toContainText(
		"Opus \u00b7 Medium \u00b7 Auto",
	);
	await view.getByTestId("composer-version").click();
	const versions = page.getByRole("menu", { name: /^Version / });
	// Latest, then the pinned versions, newest first.
	await expect(versions.getByRole("menuitemradio")).toHaveText([
		/^Latest \(5\.5\)/,
		/^5/,
		/^4\.8/,
		/^4\.7/,
	]);
	await expect(versions.getByRole("menuitemradio").first()).toHaveAttribute(
		"aria-checked",
		"true",
	);
});

test("a pinned version is asked for by its exact ID, shown in the summary, and carried to the next chat", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Pinned" });
	const host = await scriptHost(page);
	await openProject(page, student.workspaceId, project.id);
	const { id, view } = await withPickers(
		launchChat(page, student.workspaceId, project.id),
	);
	const version = view.getByTestId("composer-version");
	await version.click();
	await page
		.getByRole("menu", { name: /^Version / })
		.getByRole("menuitemradio", { name: "4.8" })
		.click();
	await expect(version).toHaveText("Version 4.8");
	await expect(picker(view, "Model")).toHaveText("Model Opus");
	await expect(view.getByTestId("composer-options")).toContainText(
		"Opus 4.8 \u00b7 Medium \u00b7 Auto",
	);
	expect(host.received(id)).toEqual([{ type: "set", model: "claude-opus-4-8" }]);
	await expect
		.poll(async () => {
			const [row] = await query<{ chat_settings: unknown }>(
				"select chat_settings from projects where id = $1",
				[project.id],
			);
			return row?.chat_settings;
		})
		.toEqual({
			model: "claude-opus-4-8",
			effort: "medium",
			mode: "auto",
			readAloud: false,
		});
	const next = await withPickers(launchChat(page, student.workspaceId, project.id));
	await expect(next.view.getByTestId("composer-version")).toHaveText("Version 4.8");

	// Another model goes back to that model's Latest.
	await choose(page, next.view, "Model", "Fable");
	await expect(next.view.getByTestId("composer-version")).toHaveText(
		"Version Latest (5.2)",
	);
});

test("a saved model the account no longer offers falls back to its family, then the default", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	const student = await createStudent(context);
	const retired = await createProject(student.workspaceId, { name: "Retired version" });
	const gone = await createProject(student.workspaceId, { name: "Retired family" });
	const save = (id: string, model: string) =>
		query("update projects set chat_settings = $2 where id = $1", [
			id,
			JSON.stringify({ model, effort: "medium", mode: "auto", readAloud: false }),
		]);
	await save(retired.id, "claude-opus-4-1");
	await save(gone.id, "claude-mystery-9");
	const host = await scriptHost(page);

	await openProject(page, student.workspaceId, retired.id);
	const one = await withPickers(launchChat(page, student.workspaceId, retired.id));
	// Opus is where the chat starts and where the retired version falls back to.
	await expect(picker(one.view, "Model")).toHaveText("Model Opus");
	await expect(one.view.getByTestId("composer-version")).toHaveText(
		"Version Latest (5.5)",
	);
	expect(host.received(one.id)).toEqual([]);

	await openProject(page, student.workspaceId, gone.id);
	const two = await withPickers(launchChat(page, student.workspaceId, gone.id));
	await expect(picker(two.view, "Model")).toHaveText("Model Default");
	await expect(two.view.getByTestId("composer-version")).toHaveCount(0);
	expect(host.received(two.id)).toEqual([{ type: "set", model: "default" }]);
});

test("on a model that cannot run Auto a new chat starts in Ask, and the saved settings still apply", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "No auto" });
	await query("update projects set chat_settings = $2 where id = $1", [
		project.id,
		JSON.stringify({
			model: "opus",
			effort: "medium",
			mode: "plan",
			readAloud: false,
		}),
	]);
	const noAuto = MODELS.map((one) =>
		one.value === "opus" ? { ...one, supportsAutoMode: false } : one,
	);
	const host = await scriptHost(page, [], {
		models: noAuto,
		start: ASK_START,
	});
	await openProject(page, student.workspaceId, project.id);
	const { id, view } = await withPickers(
		launchChat(page, student.workspaceId, project.id),
	);
	// The host's Ask counted as a fresh chat, so the saved Plan was applied.
	await expectShown(view, "Opus", "Medium", "Plan");
	expect(host.received(id)).toEqual([{ type: "set", mode: "plan" }]);
});

test("switching to a model that cannot run Auto while in Auto shows the chat in Ask", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	// The fake agent's own host, whose Haiku 4.5 cannot run Auto.
	const { id, view } = await withPickers(openChat(page, student.workspaceId, "To Ask"));
	await choose(page, view, "Permissions", "Auto");
	await expect(picker(view, "Permissions")).toHaveText("Permissions Auto");
	await choose(page, view, "Model", "Haiku");
	await expect(picker(view, "Permissions")).toHaveText("Permissions Auto");
	const version = view.getByTestId("composer-version");
	await version.click();
	await page
		.getByRole("menu", { name: /^Version / })
		.getByRole("menuitemradio", { name: "4.5" })
		.click();
	await expect(version).toHaveText("Version 4.5");
	await expect(picker(view, "Permissions")).toHaveText("Permissions Ask");
	// The page asked only for the model; the host chose Ask.
	await expect
		.poll(async () => receivedFrames(id, "set"))
		.toEqual([
			{ type: "set", mode: "auto" },
			{ type: "set", model: "haiku" },
			{ type: "set", model: "claude-haiku-4-5-20251001" },
		]);
});

for (const colorScheme of ["dark", "light"] as const) {
	test(`the options are label-over-value fields on one line, Read aloud in the heading row, and wrap when narrow (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Fields" });
		await scriptHost(page);
		await openProject(page, student.workspaceId, project.id);
		const { view } = await withPickers(
			launchChat(page, student.workspaceId, project.id),
		);
		await page.setViewportSize({ width: 1280, height: 800 });
		const box = async (target: Locator) => {
			const found = await target.boundingBox();
			if (!found) throw new Error("no layout");
			return found;
		};
		const fields = [
			"composer-agent",
			"composer-model",
			"composer-version",
			"composer-effort",
			"composer-mode",
		];
		const boxes = await Promise.all(
			fields.map((testId) => box(view.getByTestId(testId))),
		);
		// One line, in order, Model and Version side by side.
		for (const [index, one] of boxes.entries()) {
			expect(Math.abs(one.y - (boxes[0]?.y ?? 0))).toBeLessThan(2);
			if (index > 0) expect(one.x).toBeGreaterThan((boxes[index - 1]?.x ?? 0) + 1);
		}
		const [, model, version] = boxes;
		if (!model || !version) throw new Error("no model or version");
		expect(version.x - (model.x + model.width)).toBeLessThan(24);
		// Each label sits over its value, both starting at the same edge.
		for (const testId of fields) {
			const label = await box(view.getByTestId(testId).locator(".pk-picker-label"));
			const value = await box(view.getByTestId(testId).locator(".pk-picker-value"));
			expect(Math.abs(label.x - value.x)).toBeLessThan(2);
			expect(label.y + label.height).toBeLessThanOrEqual(value.y + 1);
		}
		// The switch shares the title's row and ends at the panel's end.
		const panel = await box(view.getByTestId("composer-picks"));
		const title = await box(view.locator(".pk-composer-picks-title"));
		const aloud = await box(view.getByTestId("composer-read-aloud"));
		expect(
			Math.abs(aloud.y + aloud.height / 2 - (title.y + title.height / 2)),
		).toBeLessThan(4);
		expect(aloud.y + aloud.height).toBeLessThanOrEqual((boxes[0]?.y ?? 0) + 1);
		expect(panel.x + panel.width - (aloud.x + aloud.width)).toBeLessThan(16);
		await expectNoViolations(page, '[data-testid="composer-picks"]');

		// A narrow pane wraps the fields onto more lines, never past the panel's edge.
		await page.setViewportSize({ width: 400, height: 800 });
		const narrow = await box(view.getByTestId("composer-picks"));
		const lines = new Set<number>();
		for (const testId of fields) {
			const one = await box(view.getByTestId(testId));
			lines.add(Math.round(one.y));
			expect(one.x).toBeGreaterThanOrEqual(narrow.x - 1);
			expect(one.x + one.width).toBeLessThanOrEqual(narrow.x + narrow.width + 1);
		}
		expect(lines.size).toBeGreaterThan(1);
		const narrowModel = await box(view.getByTestId("composer-model"));
		const narrowVersion = await box(view.getByTestId("composer-version"));
		expect(Math.abs(narrowModel.y - narrowVersion.y)).toBeLessThan(2);
		await expectNoViolations(page, '[data-testid="composer-picks"]');
	});
}

/** Start a Codex chat from the New tab menu, with its pickers showing. */
async function launchCodexChat(page: Page, workspaceId: string, projectId: string) {
	const before = await terminalIds(workspaceId, projectId);
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-codex-gui").click();
	await expect
		.poll(async () => (await terminalIds(workspaceId, projectId)).length)
		.toBe(before.length + 1);
	const id = (await terminalIds(workspaceId, projectId)).find(
		(one) => !before.includes(one),
	);
	if (!id) throw new Error("the Codex chat row was not created");
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(picker(view, "Model")).toBeAttached({ timeout: 15_000 });
	await openChatOptions(view);
	return { id, view };
}

test("a Codex chat's pickers draw the host's models, efforts and modes, and its choices are kept apart from Claude's", async ({
	page,
	context,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Codex pickers" });
	await openProject(page, student.workspaceId, project.id);
	const { view } = await launchCodexChat(page, student.workspaceId, project.id);
	await expect(page.getByRole("tab", { name: /Codex \(GUI\)/ })).toBeVisible();
	await expect(picker(view, "Agent")).toHaveText(/Agent\s*Codex/);
	await expect(picker(view, "Model")).toHaveText(/Model\s*GPT-5\.5/);
	await expect(view.getByTestId("composer-version")).toHaveCount(0);
	await expect(view.getByTestId("chat-composer-input")).toHaveAttribute(
		"aria-label",
		"Message Codex",
	);

	await picker(view, "Effort").click();
	const efforts = menu(page, "Effort");
	for (const name of ["Low", "Medium", "High", "Extra high", "ultra"]) {
		await expect(
			efforts.getByRole("menuitemradio", { name, exact: true }),
		).toBeVisible();
	}
	await efforts.getByRole("menuitemradio", { name: "ultra", exact: true }).click();
	await expect(picker(view, "Effort")).toHaveText(/Effort\s*ultra/);

	await picker(view, "Permissions").click();
	const modes = menu(page, "Permissions");
	for (const name of ["Ask", "Read only", "Plan", "Auto", "Full access"]) {
		await expect(modes.getByRole("menuitemradio", { name, exact: true })).toBeVisible();
	}
	await modes.getByRole("menuitemradio", { name: "Full access", exact: true }).click();
	await expect(view.getByTestId("chat-bypass-warning")).toHaveText(
		"Full access lets Codex run every command without asking you first.",
	);
	await expectNoViolations(page);

	// Kept under codex beside Claude's start values; Full access is never carried.
	await expect
		.poll(async () => {
			const [row] = await query<{ chat_settings: unknown }>(
				"select chat_settings from projects where id = $1",
				[project.id],
			);
			return row?.chat_settings;
		})
		.toMatchObject({
			model: "opus",
			effort: "medium",
			mode: "auto",
			agent: "codex",
			codex: { model: "gpt-5.5", effort: "ultra", mode: "onRequest" },
		});
});

test("the MCP servers field in Chat options lists each server's state for both agents", async ({
	page,
	context,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "MCP list" });
	await openProject(page, student.workspaceId, project.id);
	const claude = await withPickers(launchChat(page, student.workspaceId, project.id));
	const codex = await launchCodexChat(page, student.workspaceId, project.id);
	for (const { view, manage } of [
		{ view: claude.view, manage: "claude mcp" },
		{ view: codex.view, manage: "codex mcp" },
	]) {
		if (!(await view.isVisible())) {
			await page.getByRole("tab", { name: /Claude Code \(GUI\)/ }).click();
			await openChatOptions(view);
		}
		const field = view.getByTestId("composer-mcp");
		await expect(field).toHaveText(/MCP servers\s*1 of 2 connected/);
		await field.click();
		const list = view.getByRole("region", { name: "MCP servers" });
		await expect(list.getByRole("listitem")).toHaveText([
			/github\s*Connected/,
			/docs\s*Needs sign-in/,
		]);
		await expect(list).toContainText(
			`Servers are managed in a terminal, with ${manage}.`,
		);
		await expectNoViolations(page);
	}
});

test("an empty Claude chat turns into a Codex chat in its place when Codex is chosen", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Swap agents" });
	await openProject(page, student.workspaceId, project.id);
	const { id, view } = await withPickers(
		launchChat(page, student.workspaceId, project.id),
	);
	// A chat with history keeps its agent for now.
	await picker(view, "Agent").click();
	await expect(
		menu(page, "Agent").getByRole("menuitemradio", { name: "Codex" }),
	).toHaveAttribute("aria-disabled", "true");
	await page.keyboard.press("Escape");
	// Cleared, the chat is empty, and Codex takes its place with no warning.
	const box = view.getByTestId("chat-composer-input");
	await box.click();
	await page.keyboard.type("/clear ");
	await page.keyboard.press("Enter");
	await expect(view.getByTestId("chat-empty")).toBeVisible();
	await openChatOptions(view);
	await picker(view, "Agent").click();
	await menu(page, "Agent").getByRole("menuitemradio", { name: "Codex" }).click();
	await expect(page.getByRole("tab", { name: /Codex \(GUI\)/ })).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByTestId(`chat-view-${id}`)).toHaveCount(0);
	await expect(page.getByRole("tab", { name: /Claude Code/ })).toHaveCount(0);
	const codex = page.locator('[data-testid^="chat-view-"]');
	await expect(codex.getByTestId("chat-composer-input")).toHaveAttribute(
		"aria-label",
		"Message Codex",
		{ timeout: 15_000 },
	);
});

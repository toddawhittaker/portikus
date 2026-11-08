import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectNoViolations,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * The composer's agent, model, effort and permission pickers (SPEC.md
 * §8.3, §10.8, §25.8), against the fake agent's chat through the API
 * relay. Each is a menu button with a radio menu; the fake answers every
 * set with the settings it now holds.
 */

/** Open the workspace and start a chat from the New tab menu. */
async function openChat(page: Page, student: { workspaceId: string }) {
	const project = await createProject(student.workspaceId, { name: "Pickers" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-claude-gui").click();
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [id] = await terminalIds(student.workspaceId, project.id);
	if (!id) throw new Error("the chat row was not created");
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(view).toBeVisible({ timeout: 15_000 });
	// The pickers wait for the host's first settings.
	await expect(view.getByTestId("composer-model")).toBeVisible({ timeout: 15_000 });
	return { id, view };
}

/** The set frames the fake chat has received from the browser. */
async function sets(id: string): Promise<Record<string, unknown>[]> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/chats/${id}/received`);
	const body = (await response.json()) as { received: string[] };
	return body.received
		.map((frame) => JSON.parse(frame) as Record<string, unknown>)
		.filter((frame) => frame.type === "set");
}

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
	const { id, view } = await openChat(page, student);
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
		.poll(async () => sets(id))
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
	await expect.poll(async () => (await sets(id)).length).toBe(4);
});

test("each menu marks the current and the default value and says what every choice is for", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { view } = await openChat(page, student);

	await picker(view, "Permissions").click();
	const modes = menu(page, "Permissions");
	const ask = modes.getByRole("menuitemradio", { name: "Ask Default" });
	await expect(ask).toHaveAttribute("aria-checked", "true");
	await expect(ask).toHaveAccessibleDescription(/Asks before/);
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
		efforts.getByRole("menuitemradio", { name: "High Default" }),
	).toHaveAttribute("aria-checked", "false");
	await expect(efforts.getByRole("menuitemradio", { name: "Medium" })).toHaveAttribute(
		"aria-checked",
		"true",
	);
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
	const { id, view } = await openChat(page, student);
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
	await expect.poll(async () => sets(id)).toEqual([{ type: "set", model: "haiku" }]);

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
	const { view } = await openChat(page, student);
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
		const { view } = await openChat(page, student);
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

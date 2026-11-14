import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { openChat, receivedFrames } from "./chat-helpers";
import {
	createProject,
	createStudent,
	expectNoViolations,
	workspacePath,
	workTabs,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * The `/` menu (SPEC.md §10.8, §25.8): typed at the start of the
 * message, it lists the commands the host reported, narrows as the student
 * types, moves with the arrows, puts the choice in the box with Enter or
 * Tab, and closes with Escape. A terminal-only command is never sent; /model
 * opens the Model picker instead. The box is the combobox throughout.
 */

const COMMANDS = [
	{
		name: "compact",
		description: "Summarise the conversation so far",
		argumentHint: "[focus]",
		terminalOnly: false,
	},
	{ name: "review", description: "Review a pull request", terminalOnly: false },
	{ name: "config", description: "Open the settings", terminalOnly: true },
	{ name: "model", description: "Choose the model", terminalOnly: true },
	{
		name: "pr-comments",
		description: "Show the comments on a pull request",
		terminalOnly: false,
	},
];

/** A chat whose fake host lists COMMANDS in place of its default list. */
async function openCommands(page: Page, context: BrowserContext) {
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "Commands");
	const listed = await fetch(`${FAKE_AGENT_URL}/__test/chats/${id}/commands`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ commands: COMMANDS }),
	});
	expect(listed.ok).toBe(true);
	const box = view.getByTestId("chat-composer-input");
	await box.click();
	return { id, view, box };
}

/** The texts the page has sent to the chat. */
async function sends(id: string): Promise<unknown[]> {
	return (await receivedFrames(id, "send")).map((frame) => frame.text);
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`/ lists the commands at once and narrows as you type (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const { view, box } = await openCommands(page, context);
		await page.keyboard.type("/");
		const list = view.getByRole("listbox", { name: "Commands" });
		await expect(list).toBeVisible();
		await expect(list.getByRole("option")).toHaveCount(5);
		await expect(list.getByRole("option").first()).toContainText("/compact");
		await expect(list.getByRole("option").first()).toContainText("[focus]");
		await expect(list.getByRole("option").first()).toContainText(
			"Summarise the conversation so far",
		);
		await expect(list.getByRole("option", { name: /\/config/ })).toContainText(
			"Use the terminal",
		);
		await expect(view.getByTestId("composer-menu-status")).toHaveText("5 commands");
		await expect(box).toHaveAttribute("role", "combobox");
		await expect(box).toHaveAttribute("aria-expanded", "true");
		await expect(box).toHaveAttribute(
			"aria-controls",
			(await list.getAttribute("id")) ?? "",
		);
		await expectNoViolations(page, '[data-testid="chat-composer"]');
		await page.keyboard.type("co");
		await expect(list.getByRole("option")).toHaveCount(3);
		await expect(view.getByTestId("composer-menu-status")).toHaveText("3 commands");
		await page.keyboard.press("ArrowDown");
		const current = list.getByRole("option", { selected: true });
		await expect(current).toContainText("/config");
		await expect(box).toHaveAttribute(
			"aria-activedescendant",
			(await current.getAttribute("id")) ?? "",
		);
		// The current row has the selected-row look, a soft accent fill and a bar at its
		// start, and no ring of its own inside the box's.
		const look = await current.evaluate((el) => {
			const probe = (token: string) => {
				const span = document.createElement("span");
				span.style.backgroundColor = `var(${token})`;
				span.style.color = `var(${token})`;
				el.append(span);
				const style = getComputedStyle(span);
				const out = { fill: style.backgroundColor, ink: style.color };
				span.remove();
				return out;
			};
			const style = getComputedStyle(el);
			return {
				fill: style.backgroundColor,
				soft: probe("--accent-soft").fill,
				bar: style.borderInlineStartColor,
				barWidth: style.borderInlineStartWidth,
				accent: probe("--accent").ink,
				outline: style.outlineStyle,
			};
		});
		expect(look.fill).toBe(look.soft);
		expect(look.bar).toBe(look.accent);
		expect(look.barWidth).toBe("2px");
		expect(look.outline).toBe("none");
		// A command's note joins its line rather than standing apart.
		await expect(
			current.locator(".pk-composer-option-detail .pk-composer-option-note"),
		).toHaveText("Use the terminal");
		await expectNoViolations(page, '[data-testid="chat-composer"]');
	});
}

test("Enter puts the command in the box without sending, and the next Enter sends it", async ({
	page,
	context,
}) => {
	const { id, view, box } = await openCommands(page, context);
	await page.keyboard.type("/rev");
	await expect(view.getByRole("option")).toHaveCount(1);
	await page.keyboard.press("Enter");
	await expect(box).toHaveText("/review");
	await expect(view.getByRole("listbox")).toHaveCount(0);
	await expect(box).toHaveAttribute("aria-expanded", "false");
	expect(await sends(id)).toEqual([]);
	await page.keyboard.type("42");
	await page.keyboard.press("Enter");
	await expect.poll(() => sends(id)).toEqual(["/review 42"]);
});

test("Tab chooses too, a click chooses, and Escape closes the list keeping the text", async ({
	page,
	context,
}) => {
	const { view, box } = await openCommands(page, context);
	await page.keyboard.type("/");
	// The list shown is the one this test set, not the host's default.
	await expect(view.getByRole("option")).toHaveCount(COMMANDS.length);
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Tab");
	await expect(box).toHaveText("/review");
	await expect(box).toBeFocused();
	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.press("Backspace");
	await page.keyboard.type("/");
	await view.getByRole("option", { name: /\/pr-comments/ }).click();
	await expect(box).toHaveText("/pr-comments");
	await expect(box).toBeFocused();
	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.press("Backspace");
	await page.keyboard.type("/com");
	await expect(view.getByRole("listbox")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(view.getByRole("listbox")).toHaveCount(0);
	await expect(box).toHaveText("/com");
});

test("a terminal-only command is never sent; /model opens the Model picker instead", async ({
	page,
	context,
}) => {
	const { id, view, box } = await openCommands(page, context);
	await page.keyboard.type("/config");
	const config = view.getByRole("option", { name: /\/config/ });
	await expect(config).toHaveAttribute("aria-disabled", "true");
	await page.keyboard.press("Enter");
	await expect(view.getByTestId("chat-composer-status")).toHaveText(
		"/config works only in the terminal, so it is not sent.",
	);
	await expect(box).toHaveText("/config");
	expect(await sends(id)).toEqual([]);

	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.press("Backspace");
	await page.keyboard.type("/mod");
	await expect(view.getByRole("option", { name: /\/model/ })).toContainText(
		"Use the Model picker",
	);
	await page.keyboard.press("Enter");
	await expect(page.getByRole("menu", { name: /^Model / })).toBeVisible();
	await expect(box).toHaveText("");
	expect(await sends(id)).toEqual([]);
});

test("/ after the start of the message is only a slash", async ({ page, context }) => {
	const { view, box } = await openCommands(page, context);
	await page.keyboard.type("either/or /compact");
	await expect(box).toHaveText("either/or /compact");
	await expect(view.getByRole("listbox")).toHaveCount(0);
});

test("/mcp opens the MCP server list in Chat options instead of reaching the agent", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "MCP command");
	const box = view.getByTestId("chat-composer-input");
	await box.click();
	await page.keyboard.type("/mc");
	await expect(view.getByRole("option", { name: /\/mcp/ })).toContainText(
		"Shown in Chat options",
	);
	await page.keyboard.press("Enter");
	const field = view.getByTestId("composer-mcp");
	await expect(field).toBeFocused();
	await expect(field).toHaveAttribute("aria-expanded", "true");
	await expect(view.getByRole("region", { name: "MCP servers" })).toContainText(
		"github",
	);
	await expect(box).toHaveText("");
	expect(await sends(id)).toEqual([]);
});

test("$ in a Codex chat lists the skills alone, and / lists them with their $", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Codex skills" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-codex-gui").click();
	const view = page.locator('[data-testid^="chat-view-"]');
	await expect(view.getByTestId("composer-model")).toBeAttached({ timeout: 15_000 });
	const box = view.getByTestId("chat-composer-input");
	await box.click();
	await page.keyboard.type("$");
	const skills = view.getByRole("listbox", { name: "Skills" });
	await expect(skills.getByRole("option")).toHaveText([/\$pdf/]);
	await expectNoViolations(page);
	await page.keyboard.press("Enter");
	await expect(box).toHaveText("$pdf");
	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.press("Backspace");
	await page.keyboard.type("/pd");
	await expect(
		view.getByRole("listbox", { name: "Commands" }).getByRole("option"),
	).toHaveText([/\$pdf/]);
});

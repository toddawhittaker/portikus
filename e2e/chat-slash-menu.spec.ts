import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { type Frame, makeChatTab, scriptChat } from "./chat-helpers";
import { expectNoViolations } from "./helpers";

/**
 * The `/` menu (SPEC.md §10.8, §25.8; #1782): typed at the start of the
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

/** A chat whose scripted host lists COMMANDS; the frames the page sends are kept. */
async function openCommands(page: Page, context: BrowserContext) {
	const { id } = await makeChatTab(page, context);
	const received: { type: string; text?: string }[] = [];
	const first: Frame[] = [["commands", { commands: COMMANDS }]];
	const view = await scriptChat(page, id, {
		first,
		reply: (message) => received.push(message),
	});
	const box = view.getByTestId("chat-composer-input");
	await box.click();
	return { view, box, received };
}

const sends = (received: { type: string }[]) =>
	received.filter((message) => message.type === "send");

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
		await expectNoViolations(page, '[data-testid="chat-composer"]');
	});
}

test("Enter puts the command in the box without sending, and the next Enter sends it", async ({
	page,
	context,
}) => {
	const { view, box, received } = await openCommands(page, context);
	await page.keyboard.type("/rev");
	await expect(view.getByRole("listbox")).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(box).toHaveText("/review");
	await expect(view.getByRole("listbox")).toHaveCount(0);
	await expect(box).toHaveAttribute("aria-expanded", "false");
	expect(sends(received)).toEqual([]);
	await page.keyboard.type("42");
	await page.keyboard.press("Enter");
	await expect
		.poll(() => sends(received).map((message) => message.text))
		.toEqual(["/review 42"]);
});

test("Tab chooses too, a click chooses, and Escape closes the list keeping the text", async ({
	page,
	context,
}) => {
	const { view, box } = await openCommands(page, context);
	await page.keyboard.type("/");
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
	const { view, box, received } = await openCommands(page, context);
	await page.keyboard.type("/config");
	const config = view.getByRole("option", { name: /\/config/ });
	await expect(config).toHaveAttribute("aria-disabled", "true");
	await page.keyboard.press("Enter");
	await expect(view.getByTestId("chat-composer-status")).toHaveText(
		"/config works only in the terminal, so it is not sent.",
	);
	await expect(box).toHaveText("/config");
	expect(sends(received)).toEqual([]);

	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.press("Backspace");
	await page.keyboard.type("/mod");
	await expect(view.getByRole("option", { name: /\/model/ })).toContainText(
		"Use the Model picker",
	);
	await page.keyboard.press("Enter");
	await expect(page.getByRole("menu", { name: /^Model / })).toBeVisible();
	await expect(box).toHaveText("");
	expect(sends(received)).toEqual([]);
});

test("/ after the start of the message is only a slash", async ({ page, context }) => {
	const { view, box } = await openCommands(page, context);
	await page.keyboard.type("either/or /compact");
	await expect(box).toHaveText("either/or /compact");
	await expect(view.getByRole("listbox")).toHaveCount(0);
});

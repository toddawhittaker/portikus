import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { openChat, receivedFrames } from "./chat-helpers";
import { createStudent, expectNoViolations } from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * The composer in shell mode (SPEC.md §10.8, §25.8): while the message
 * starts with `!` the box wears a "Shell" label and monospace text, says
 * "Shell command mode" once, and opens neither the `/` nor the `@` menu. The
 * difference is the label and the type, not colour alone, and holds up in
 * both themes. The host running the command is another task's.
 */

const COMMANDS = [
	{ name: "compact", description: "Summarise the conversation", terminalOnly: false },
	{ name: "review", description: "Review a pull request", terminalOnly: false },
];

async function openShell(page: Page, context: BrowserContext) {
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "Shell");
	const listed = await fetch(`${FAKE_AGENT_URL}/__test/chats/${id}/commands`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ commands: COMMANDS }),
	});
	expect(listed.ok).toBe(true);
	const box = view.getByTestId("chat-composer-input");
	await box.click();
	return {
		id,
		view,
		box,
		form: view.getByTestId("chat-composer"),
		label: view.getByTestId("chat-composer-shell"),
		status: view.getByTestId("chat-composer-status"),
	};
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`! marks the box as a shell command, in words and type (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const { view, box, form, label, status } = await openShell(page, context);
		const fontOf = () => box.evaluate((el) => getComputedStyle(el).fontFamily);
		const plain = await fontOf();
		expect(plain).not.toMatch(/mono/i);

		await page.keyboard.type("!");
		// A lone ! is no command yet.
		await expect(label).toHaveCount(0);
		await page.keyboard.type("ls -la");
		await expect(label).toBeVisible();
		await expect(label).toHaveText("Shell");
		await expect(status).toHaveText("Shell command mode");
		await expect(view.getByTestId("chat-composer-hint")).toContainText(
			"Shell command. Enter runs it",
		);
		await expect.poll(fontOf).toMatch(/mono/i);
		// The hint is the box's description, so the mode is read on focus too.
		const described = await box.getAttribute("aria-describedby");
		expect(described).toContain(
			(await view.getByTestId("chat-composer-hint").getAttribute("id")) ?? "",
		);
		await expectNoViolations(page, '[data-testid="chat-composer"]');
		await form.screenshot({ path: `screenshots/composer-shell-${colorScheme}.png` });

		// Taking the ! away puts the box back.
		await box.click();
		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.type("ls -la");
		await expect(box).toHaveText("ls -la");
		await expect(label).toHaveCount(0);
		await expect(status).toHaveText("");
		await expect.poll(fontOf).toBe(plain);
		await expectNoViolations(page, '[data-testid="chat-composer"]');
	});
}

test("the / and @ menus stay shut in a shell command, and open again outside one", async ({
	page,
	context,
}) => {
	const { view, box } = await openShell(page, context);
	await page.route("**/file-search", (route) =>
		route.fulfill({ json: { paths: ["src/app.ts"], truncated: false } }),
	);
	await page.keyboard.type("!cat @src");
	await expect(box).toHaveText("!cat @src");
	await page.waitForTimeout(600);
	await expect(view.getByRole("listbox")).toHaveCount(0);
	await expect(box).toHaveAttribute("aria-expanded", "false");

	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.press("Backspace");
	await page.keyboard.type("cat @src");
	await expect(view.getByRole("option", { name: /src\/app\.ts/ })).toBeVisible();

	// A / menu already open shuts when ! is put in front of it.
	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.press("Backspace");
	await page.keyboard.type("/com");
	await expect(view.getByRole("listbox", { name: "Commands" })).toBeVisible();
	await page.keyboard.press("Home");
	await page.keyboard.type("!");
	await expect(view.getByRole("listbox")).toHaveCount(0);
});

test("Enter sends the ! message as typed, and the mode is announced again next time", async ({
	page,
	context,
}) => {
	const { id, view, box, label, status } = await openShell(page, context);
	await page.keyboard.type("!pwd");
	await expect(status).toHaveText("Shell command mode");
	await page.keyboard.press("Enter");
	await expect
		.poll(async () => (await receivedFrames(id, "send")).map((frame) => frame.text))
		.toEqual(["!pwd"]);
	// The host echoes it and the box empties, leaving the mode.
	await expect(box).toHaveText("");
	await expect(label).toHaveCount(0);
	await expect(status).toHaveText("");
	await page.keyboard.type("!ls");
	await expect(label).toBeVisible();
	await expect(status).toHaveText("Shell command mode");
	await expect(view.getByTestId("chat-composer-hint")).toContainText("Shell command.");
});

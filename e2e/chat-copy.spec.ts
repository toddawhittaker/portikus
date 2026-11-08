import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { makeChatTab } from "./chat-helpers";
import { expectNoViolations } from "./helpers";

/**
 * Messages in the chat (SPEC.md §10.8, §25.8): the student's own message is
 * drawn as the Markdown they sent, and a message, a code block or a tool's
 * output copies as raw text from a button that hover and the keyboard find.
 */

const SENT = "Make the test **pass** with `npm test`\nthen:\n\n- lint\n- build";
const CODE = 'npm test -- --run\necho "done"';
const REPLY = ["Run this:", "", "```sh", CODE, "```", "", "It **should** pass."].join(
	"\n",
);
const OUTPUT = "3 passed\n0 failed";

async function openChat(page: Page, context: BrowserContext) {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const { id } = await makeChatTab(page, context);
	await page.routeWebSocket(/\/chat$/, (ws) => {
		let seq = 0;
		const send = (type: string, body: Record<string, unknown> = {}) =>
			ws.send(
				JSON.stringify({
					type,
					sessionId: "00000000-0000-4000-8000-000000000000",
					seq: seq++,
					...body,
				}),
			);
		send("snapshot", { cards: [], turnRunning: false, truncated: false });
		send("message", { id: "u1", role: "user", markdown: SENT });
		send("turn.started", { at: Date.now() - 5_000 });
		send("tool.started", {
			id: "t1",
			name: "Bash",
			title: "npm test",
			input: { command: "npm test" },
		});
		send("tool.output", { id: "t1", part: { type: "text", text: OUTPUT } });
		send("tool.finished", { id: "t1", isError: false });
		send("message", { id: "a1", role: "assistant", markdown: REPLY });
		send("turn.finished", { at: Date.now(), status: "done" });
		send("settings", {
			agent: "claude",
			model: "default",
			effort: "high",
			mode: "default",
		});
	});
	await page.reload();
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(view).toBeVisible({ timeout: 15_000 });
	return view;
}

function clipboard(page: Page) {
	return page.evaluate(() => navigator.clipboard.readText());
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`a code block and a reply copy from the keyboard and by hover (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme });
		const view = await openChat(page, context);
		const reply = view.getByTestId("chat-assistant-message");

		// The button waits out of sight until the keyboard reaches it.
		const copyCode = reply.getByRole("button", { name: "Copy code" });
		const codeCorner = reply.locator(".pk-chat-pre > .pk-chat-copy");
		await expect(codeCorner).toHaveCSS("opacity", "0");
		await reply.locator("pre").focus();
		await page.keyboard.press("Tab");
		await expect(copyCode).toBeFocused();
		await expect(codeCorner).toHaveCSS("opacity", "1");
		await page.keyboard.press("Enter");
		await expect(reply.getByRole("status").first()).toHaveText("Copied");
		expect(await clipboard(page)).toBe(CODE);
		await expectNoViolations(page, `[data-testid^="chat-view-"]`);

		await page.mouse.move(0, 0);
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		const copyReply = reply.getByRole("button", { name: "Copy message" });
		await expect(reply.locator("> .pk-chat-copy")).toHaveCSS("opacity", "0");
		await reply.locator(".pk-chat-md").hover();
		await expect(reply.locator("> .pk-chat-copy")).toHaveCSS("opacity", "1");
		await copyReply.click();
		await expect.poll(() => clipboard(page)).toBe(REPLY);
	});
}

test("the student's message shows its Markdown and copies as sent", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	const view = await openChat(page, context);
	const sent = view.getByTestId("chat-user-message");
	await expect(sent.locator("strong")).toHaveText("pass");
	await expect(sent.locator("code")).toHaveText("npm test");
	await expect(sent.getByRole("listitem")).toHaveText(["lint", "build"]);
	// No Markdown marks are left showing.
	await expect(sent).not.toContainText("**");
	await expect(sent).not.toContainText("`");

	await sent.hover();
	await sent.getByRole("button", { name: "Copy message" }).click();
	await expect.poll(() => clipboard(page)).toBe(SENT);
});

test("a tool's output copies whole", async ({ page, context }) => {
	test.setTimeout(90_000);
	const view = await openChat(page, context);
	await view.getByTestId("chat-worked").locator("> summary").click();
	await view.getByTestId("chat-tool-t1").locator("> summary").click();
	const output = view.getByRole("region", { name: "Output" });
	await output.locator("pre").focus();
	await page.keyboard.press("Tab");
	const copy = output.getByRole("button", { name: "Copy output" });
	await expect(copy).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(output.getByRole("status")).toHaveText("Copied");
	expect(await clipboard(page)).toBe(OUTPUT);
});

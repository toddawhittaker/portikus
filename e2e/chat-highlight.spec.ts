import {
	type BrowserContext,
	expect,
	type Page,
	type Route,
	test,
} from "@playwright/test";
import { makeChatTab, scriptedChat } from "./chat-helpers";
import { expectNoViolations } from "./helpers";

/**
 * Syntax colours in a reply (#1784, ADR 0072): a fenced block in a known
 * language is named and coloured once the highlighter loads, plain text
 * until then with nothing moving; an unknown language is named and stays
 * plain. The highlighter loads only when such a block is drawn (SPEC.md
 * §25.1), and the colours meet contrast in both themes (SPEC.md §25.8).
 */

const PYTHON = 'def greet(name):\n    # say hello\n    return "hi " + name';
const RUST = "fn main() { let x = 1; }";
const REPLY = [
	"Try this:",
	"",
	"```python",
	PYTHON,
	"```",
	"",
	"```rust",
	RUST,
	"```",
].join("\n");

/**
 * The highlighter's own chunk, built or from the development server; held
 * back to see the plain first draw.
 */
const HIGHLIGHTER = /(\/assets\/core-[\w-]+|highlight(\.js\/lib\/|__js_lib_)core)\.js/;

async function openReply(page: Page, context: BrowserContext, markdown: string) {
	const { id } = await makeChatTab(page, context);
	await page.routeWebSocket(/\/chat$/, (ws) => {
		const send = scriptedChat(ws, "00000000-0000-4000-8000-000000000000");
		send("snapshot", { cards: [], turnRunning: false, truncated: false });
		send("message", { id: "a1", role: "assistant", markdown });
		send("settings", {
			agent: "claude",
			model: "default",
			effort: "high",
			mode: "default",
		});
	});
	return id;
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`a reply's code is named and coloured, plain first with no shift (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme });
		const id = await openReply(page, context, REPLY);
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route(HIGHLIGHTER, async (route: Route) => {
			await held;
			await route.continue();
		});
		await page.reload();
		const reply = page
			.getByTestId(`chat-view-${id}`)
			.getByTestId("chat-assistant-message");
		const [python, rust] = [reply.locator("pre").nth(0), reply.locator("pre").nth(1)];

		// Named at once, plain until the highlighter arrives.
		await expect(reply.locator(".pk-chat-lang")).toHaveText(["Python", "rust"]);
		await expect(python).toHaveText(PYTHON);
		await expect(python.locator("[class^=hljs]")).toHaveCount(0);
		const before = await python.boundingBox();

		release();
		await expect(python.locator(".hljs-keyword").first()).toHaveText("def");
		await expect(python.locator(".hljs-comment")).toHaveText("# say hello");
		await expect(python).toHaveText(PYTHON);
		expect(await python.boundingBox()).toEqual(before);
		const plain = await python.evaluate((pre) => getComputedStyle(pre).color);
		const keyword = await python
			.locator(".hljs-keyword")
			.first()
			.evaluate((span) => getComputedStyle(span).color);
		expect(keyword).not.toBe(plain);

		// An unknown language is never guessed at.
		await expect(rust).toHaveText(RUST);
		await expect(rust.locator("[class^=hljs]")).toHaveCount(0);

		await expectNoViolations(page, `[data-testid^="chat-view-"]`);
	});
}

test("a reply with no code in a known language never loads the highlighter", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	const id = await openReply(page, context, "Plain words, and:\n\n```\nuntagged\n```");
	const loads: string[] = [];
	page.on("request", (request) => {
		if (HIGHLIGHTER.test(request.url())) loads.push(request.url());
	});
	await page.reload();
	const reply = page
		.getByTestId(`chat-view-${id}`)
		.getByTestId("chat-assistant-message");
	await expect(reply.locator("pre")).toHaveText("untagged");
	await expect(reply.locator(".pk-chat-lang")).toHaveCount(0);
	await page.waitForLoadState("networkidle");
	expect(loads).toEqual([]);
});

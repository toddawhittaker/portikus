import { expect, type Locator, type Page, test } from "@playwright/test";
import { openChat, receivedFrames } from "./chat-helpers";
import { createStudent, expectNoViolations } from "./helpers";

/**
 * The composer's Markdown beyond emphasis and lists (SPEC.md §10.8,
 * §25.8): each shortcut typed shows formatted with its markers hidden,
 * and the message sent is the Markdown again. Links keep to http and
 * https, as replies do (SPEC.md §24.3).
 */

async function sentText(id: string): Promise<string> {
	await expect.poll(async () => (await receivedFrames(id, "send")).length).toBe(1);
	const [frame] = await receivedFrames(id, "send");
	return frame?.text as string;
}

async function newLine(page: Page) {
	await page.keyboard.press("Shift+Enter");
}

async function open(page: Page, context: Parameters<typeof createStudent>[0]) {
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "Markdown");
	const box: Locator = view.getByTestId("chat-composer-input");
	await box.click();
	return { id, view, box };
}

test("quotes, headings, separators, strikethrough and bold italics show formatted and send as Markdown", async ({
	page,
	context,
}) => {
	const { id, box } = await open(page, context);
	await page.keyboard.type("# Plan");
	await expect(box.locator("h1")).toHaveText("Plan");
	await newLine(page);
	await page.keyboard.type("## Steps");
	await expect(box.locator("h2")).toHaveText("Steps");
	await newLine(page);
	await page.keyboard.type("### Small");
	await expect(box.locator("h3")).toHaveText("Small");
	await newLine(page);
	await page.keyboard.type("a ~~gone~~ and ***loud*** end");
	await expect(box.locator("s")).toHaveText("gone");
	await expect(box.locator("strong em, em strong")).toHaveText("loud");
	await newLine(page);
	await page.keyboard.type("---");
	await expect(box.locator("hr")).toHaveCount(1);
	await page.keyboard.type("> quoted");
	await expect(box.locator("blockquote")).toHaveText("quoted");
	await expect(box).not.toContainText("#");
	await expect(box).not.toContainText("~~");
	await expect(box).not.toContainText("*");
	await page.keyboard.press("Enter");
	expect(await sentText(id)).toBe(
		"# Plan\n\n## Steps\n\n### Small\n\na ~~gone~~ and ***loud*** end\n\n---\n\n> quoted",
	);
});

test("tasks and nested lists: [ ] and [x] make tasks, Tab and Shift+Tab indent and outdent", async ({
	page,
	context,
}) => {
	const { id, box } = await open(page, context);
	await page.keyboard.type("- [ ] milk");
	await newLine(page);
	await page.keyboard.type("[x] rent");
	const tasks = box.locator('ul[data-type="taskList"] > li');
	await expect(tasks).toHaveCount(2);
	await expect(tasks.nth(1).getByRole("checkbox")).toBeChecked();
	await expect(box).not.toContainText("[");
	await newLine(page);
	await newLine(page);
	await page.keyboard.type("- one");
	await newLine(page);
	await page.keyboard.type("two");
	await page.keyboard.press("Tab");
	await expect(box.locator("ul ul > li")).toHaveText("two");
	await expect(box).toBeFocused();
	await newLine(page);
	await page.keyboard.type("three");
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Enter");
	expect(await sentText(id)).toBe("- [ ] milk\n- [x] rent\n\n- one\n  - two\n- three");
});

test("Tab outside a list still leaves the box", async ({ page, context }) => {
	const { box } = await open(page, context);
	await page.keyboard.type("plain text");
	await page.keyboard.press("Tab");
	await expect(box).not.toBeFocused();
});

test("[text](url), a typed address and a pasted address become links; other schemes stay text", async ({
	page,
	context,
}) => {
	const { id, box } = await open(page, context);
	await page.keyboard.type(
		"see [the docs](https://example.com/a) and https://example.org ",
	);
	await page.keyboard.type("not [bad](javascript:alert(1)) ");
	const links = box.locator("a");
	await expect(links).toHaveCount(2);
	await expect(links.first()).toHaveAttribute("href", "https://example.com/a");
	await expect(links.first()).toHaveText("the docs");
	await expect(links.nth(1)).toHaveAttribute("href", "https://example.org");
	await page.evaluate(() => {
		const transfer = new DataTransfer();
		transfer.setData("text/plain", "https://example.net/x");
		document.querySelector('[data-testid="chat-composer-input"]')?.dispatchEvent(
			new ClipboardEvent("paste", {
				clipboardData: transfer,
				bubbles: true,
				cancelable: true,
			}),
		);
	});
	await expect(links).toHaveCount(3);
	await expect(links.nth(2)).toHaveAttribute("href", "https://example.net/x");
	await expect(box.locator('a[href^="javascript"]')).toHaveCount(0);
	await page.keyboard.press("Enter");
	expect(await sentText(id)).toBe(
		"see [the docs](https://example.com/a) and https://example.org not [bad](javascript:alert(1)) https://example.net/x",
	);
});

for (const colorScheme of ["light", "dark"] as const) {
	for (const width of [1280, 360] as const) {
		test(`the formatted box has no accessibility violations (${colorScheme}, ${width})`, async ({
			page,
			context,
		}) => {
			await page.setViewportSize({ width, height: 900 });
			await page.emulateMedia({ colorScheme });
			const { view, box } = await open(page, context);
			await page.keyboard.type("## A heading");
			await newLine(page);
			await page.keyboard.type("> a quote with a [link](https://example.com)");
			await page.keyboard.press("Shift+Enter");
			await page.keyboard.press("Shift+Enter");
			await page.keyboard.type("---");
			await page.keyboard.type(
				"- [ ] a task with a-very-long-unbroken-name-that-keeps-going-and-going",
			);
			await newLine(page);
			await page.keyboard.type("a ~~struck~~ ***loud*** line");
			await expect(box.locator("hr")).toHaveCount(1);
			await expectNoViolations(page, '[data-testid="chat-composer"]');
			const overflow = await box.evaluate(
				(node) => node.scrollWidth - node.clientWidth,
			);
			expect(overflow).toBeLessThanOrEqual(0);
			await view.getByTestId("chat-composer").screenshot({
				path: `screenshots/chat-composer-markdown-${colorScheme}-${width}.png`,
			});
		});
	}
}

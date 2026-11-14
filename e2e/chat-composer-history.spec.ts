import { expect, type Locator, test } from "@playwright/test";
import { type ChatAgent, makeChatTab, openChat } from "./chat-helpers";
import { createStudent, workspacePath } from "./helpers";

/**
 * Up and Down in the message box go back and forward through the messages
 * sent in this chat, as a shell does (SPEC.md §10.8): Up on the box's first
 * line, Down on its last, the draft given back past the newest, and an open
 * `/` or `@` menu keeping the arrows. The same for Claude and Codex.
 */

const AGENTS: ChatAgent[] = ["claude", "codex"];

/** Send each text and wait for the host's echo to clear the box. */
async function sendEach(box: Locator, ...texts: string[]) {
	for (const text of texts) {
		await box.fill(text);
		await box.press("Enter");
		await expect(box).toHaveText("");
	}
}

for (const agent of AGENTS) {
	test.describe(`${agent} chat`, () => {
		test("Up and Down walk the messages sent, and Down past the newest gives the draft back", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const { view } = await openChat(page, student.workspaceId, "History", agent);
			const box = view.getByTestId("chat-composer-input");
			await sendEach(box, "first message", "second **message**", "third message");
			await box.pressSequentially("my **draft**");
			await box.press("ArrowUp");
			await expect(box).toHaveText("third message");
			await box.press("ArrowUp");
			await expect(box).toHaveText("second message");
			// Sent in this page, so it comes back with its formatting.
			await expect(box.locator("strong")).toHaveText("message");
			await box.press("ArrowUp");
			await expect(box).toHaveText("first message");
			// The conversation began with the fake host's earlier question: the oldest.
			await box.press("ArrowUp");
			await expect(box).toHaveText("Earlier question");
			await box.press("ArrowUp");
			await expect(box).toHaveText("Earlier question");
			await box.press("ArrowDown");
			await expect(box).toHaveText("first message");
			await box.press("ArrowDown");
			await expect(box).toHaveText("second message");
			await box.press("ArrowDown");
			await box.press("ArrowDown");
			await expect(box).toHaveText("my draft");
			await expect(box.locator("strong")).toHaveText("draft");
			// The cursor sits at the end of what came back.
			await box.pressSequentially("!");
			await expect(box).toHaveText("my draft!");
		});

		test("a recalled message can be edited and sent, and starts the history afresh", async ({
			page,
			context,
		}) => {
			const student = await createStudent(context);
			const { view } = await openChat(page, student.workspaceId, "History edit", agent);
			const box = view.getByTestId("chat-composer-input");
			await sendEach(box, "alpha", "beta", "gamma");
			await box.press("ArrowUp");
			await box.press("ArrowUp");
			await expect(box).toHaveText("beta");
			await box.pressSequentially(" edited");
			await box.press("ArrowUp");
			await expect(box).toHaveText("gamma");
			await box.press("ArrowDown");
			await expect(box).toHaveText("beta edited");
			await box.press("Enter");
			await expect(box).toHaveText("");
			await expect(view.getByText("beta edited", { exact: true })).toBeVisible();
			await box.press("ArrowUp");
			await expect(box).toHaveText("beta edited");
		});

		test("the history is the conversation's, so a chat opened again has it", async ({
			page,
			context,
		}) => {
			const { student, project, id } = await makeChatTab(page, context, agent);
			await page.goto(workspacePath(student.workspaceId, project.id));
			const view = page.getByTestId(`chat-view-${id}`);
			await expect(view).toBeVisible({ timeout: 15_000 });
			await expect(view.getByText("Earlier question")).toBeVisible();
			const box = view.getByTestId("chat-composer-input");
			await box.press("ArrowUp");
			await expect(box).toHaveText("Earlier question");
			await box.press("ArrowUp");
			await expect(box).toHaveText("Earlier question");
			await box.press("ArrowDown");
			await expect(box).toHaveText("");
		});
	});
}

test("Up needs the first line and Down the last, in lines and in a long wrapped line", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { view } = await openChat(page, student.workspaceId, "History lines");
	const box = view.getByTestId("chat-composer-input");
	await sendEach(box, "older message");

	await box.pressSequentially("top");
	await box.press("Shift+Enter");
	await box.pressSequentially("middle");
	await box.press("Shift+Enter");
	await box.pressSequentially("bottom");
	const lines = "top\nmiddle\nbottom";
	// On the last line Up moves up a line; the text stays.
	await box.press("ArrowUp");
	await expect(box).toHaveText(/top\s*middle\s*bottom/);
	await box.press("ArrowUp");
	await expect(box).toHaveText(/top\s*middle\s*bottom/);
	// On the first line Up recalls.
	await box.press("ArrowUp");
	await expect(box).toHaveText("older message");
	// The draft is back whole, with the cursor at its end, the last line.
	await box.press("ArrowDown");
	await expect(box).toHaveText(/top\s*middle\s*bottom/);
	await expect(box.locator("p")).toHaveCount(lines.split("\n").length);
	// Down from the first line moves down a line.
	await box.press("ControlOrMeta+Home");
	await box.press("ArrowDown");
	await expect(box).toHaveText(/top\s*middle\s*bottom/);

	// A single line long enough to wrap is walked a visual line at a time.
	await box.fill("");
	const long = Array.from({ length: 300 }, (_, at) => `word${at}`).join(" ");
	await box.fill(long);
	const text = await box.textContent();
	await box.press("ArrowUp");
	await expect(box).toHaveText(text);
	for (let press = 0; press < 80; press += 1) {
		await box.press("ArrowUp");
		if ((await box.textContent()) !== text) break;
	}
	await expect(box).toHaveText("older message");
});

test("with the slash menu open the arrows move the menu and not the history", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { view } = await openChat(page, student.workspaceId, "History menu");
	const box = view.getByTestId("chat-composer-input");
	await sendEach(box, "older message");
	await box.pressSequentially("/");
	const list = view.getByRole("listbox", { name: "Commands" });
	await expect(list).toBeVisible();
	const options = list.getByRole("option");
	await expect(options.first()).toHaveAttribute("aria-selected", "true");
	await box.press("ArrowDown");
	await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
	await box.press("ArrowUp");
	await expect(options.first()).toHaveAttribute("aria-selected", "true");
	await expect(box).toHaveText("/");
	// With the menu closed the arrows are the history's again.
	await box.press("Escape");
	await expect(list).toHaveCount(0);
	await box.press("ArrowUp");
	await expect(box).toHaveText("older message");
});

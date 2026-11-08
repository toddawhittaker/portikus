import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { makeChatTab, scriptedChat } from "./chat-helpers";
import { expectNoViolations } from "./helpers";

/**
 * A new chat helps a student start (SPEC.md §8.3): a few starter prompts
 * under the privacy sentence, and a click puts one in the message box to
 * edit. It is never sent on its own.
 */

async function openEmptyChat(page: Page, context: BrowserContext) {
	const { id } = await makeChatTab(page, context);
	const sent: { type: string }[] = [];
	await page.routeWebSocket(/\/chat$/, (ws) => {
		const send = scriptedChat(ws, "00000000-0000-4000-8000-000000000000");
		send("snapshot", { cards: [], turnRunning: false, truncated: false });
		send("settings", {
			agent: "claude",
			model: "default",
			effort: "high",
			mode: "default",
		});
		ws.onMessage((raw) => sent.push(JSON.parse(String(raw))));
	});
	await page.reload();
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(view.getByTestId("chat-empty")).toBeVisible({ timeout: 15_000 });
	return { view, sent };
}

for (const colorScheme of ["light", "dark"] as const) {
	for (const width of [1280, 420] as const) {
		test(`an empty chat offers starter prompts (${colorScheme}, ${width})`, async ({
			page,
			context,
		}) => {
			test.setTimeout(90_000);
			await page.emulateMedia({ colorScheme });
			await page.setViewportSize({ width, height: 800 });
			const { view, sent } = await openEmptyChat(page, context);
			const empty = view.getByTestId("chat-empty");
			await expect(empty).toContainText(
				"The conversation is kept in your workspace, not by Portikus.",
			);
			const starters = empty.getByRole("listitem");
			await expect(starters).toHaveText([
				"Explain how this project is organised",
				"Find a bug and explain it before fixing it",
				"Write tests for the main file",
			]);
			// Each starter fits the pane, however narrow.
			const pane = await view.boundingBox();
			for (const box of await starters.getByRole("button").all()) {
				const rect = await box.boundingBox();
				expect((rect?.x ?? 0) + (rect?.width ?? 0)).toBeLessThanOrEqual(
					(pane?.x ?? 0) + (pane?.width ?? 0),
				);
			}
			await expectNoViolations(page, `[data-testid^="chat-view-"]`);

			// Keyboard: reach a starter, press Enter, and type on from where it left the cursor.
			const find = empty.getByRole("button", {
				name: "Find a bug and explain it before fixing it",
			});
			await find.focus();
			await page.keyboard.press("Enter");
			const box = view.getByTestId("chat-composer-input");
			await expect(box).toBeFocused();
			await expect(box).toHaveText("Find a bug and explain it before fixing it");
			await page.keyboard.type(" in the login form");
			await expect(box).toHaveText(
				"Find a bug and explain it before fixing it in the login form",
			);
			// Another starter never replaces a draft; nothing has gone to Claude.
			await empty
				.getByRole("button", { name: "Write tests for the main file" })
				.click();
			await expect(box).toBeFocused();
			await expect(box).toHaveText(
				"Find a bug and explain it before fixing it in the login form",
			);
			expect(sent.filter((message) => message.type === "send")).toEqual([]);
		});
	}
}

test("a starter is sent only when the student sends it", async ({ page, context }) => {
	test.setTimeout(90_000);
	const { view, sent } = await openEmptyChat(page, context);
	await view
		.getByTestId("chat-empty")
		.getByRole("button", { name: "Explain how this project is organised" })
		.click();
	await page.keyboard.press("Enter");
	await expect
		.poll(() => sent.filter((message) => message.type === "send"))
		.toEqual([
			{ type: "send", text: "Explain how this project is organised", attachments: [] },
		]);
});

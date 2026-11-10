import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { makeChatTab, scriptedChat } from "./chat-helpers";
import { expectNoViolations } from "./helpers";

/**
 * Deny opens a one-line field whose text goes back to Claude as the denial,
 * and plan approval names the mode to go on in (SPEC.md §10.8, §25.8). The
 * chat socket is answered by a script in the test, standing in for the host,
 * which sends the new mode back in a settings event as Claude Code does.
 */

const FIELD = "Tell Claude what to do instead";

const BASH = {
	type: "permission",
	id: "p1",
	toolName: "Bash",
	title: "rm -rf build",
	input: { command: "rm -rf build" },
	options: [
		{ id: "allow", label: "Allow once" },
		{ id: "deny", label: "Deny" },
	],
};

const PLAN = {
	type: "permission",
	id: "p2",
	toolName: "ExitPlanMode",
	title: "Claude has a plan. Start working on it?",
	input: { plan: "1. Add the test\n2. Fix the bug" },
	options: [
		{ id: "allow-accept-edits", label: "Yes, and accept edits" },
		{ id: "allow-ask-edits", label: "Yes, and ask before edits" },
		{ id: "deny", label: "No, keep planning" },
	],
};

/** A chat whose host shows `cards` and records what the browser answers. */
const PLAN_MODE: Record<string, string> = {
	"allow-accept-edits": "acceptEdits",
	"allow-ask-edits": "default",
};

async function openWithCards(
	page: Page,
	context: Parameters<typeof makeChatTab>[1],
	cards: unknown[],
) {
	const { id } = await makeChatTab(page, context);
	const received: Record<string, unknown>[] = [];
	await page.routeWebSocket(/\/chat$/, (ws: WebSocketRoute) => {
		const send = scriptedChat(ws, id);
		send("snapshot", { cards, turnRunning: true, truncated: false });
		send("settings", {
			agent: "claude",
			model: "claude-haiku-4-5",
			effort: "high",
			mode: "plan",
		});
		send("rules", { rules: [] });
		ws.onMessage((raw) => {
			const message = JSON.parse(String(raw));
			if (message.type !== "permission.answer") return;
			received.push(message);
			// The host derives a plan's mode from the option it was approved with.
			const mode = PLAN_MODE[message.optionId];
			if (mode) {
				send("settings", {
					agent: "claude",
					model: "claude-haiku-4-5",
					effort: "high",
					mode,
				});
			}
			send("card.resolved", { id: message.id });
		});
	});
	await page.reload();
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(view.getByTestId("chat-permission-card")).toBeVisible({
		timeout: 15_000,
	});
	return { view, received };
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`Deny takes a reason, Escape goes back, and Enter sends it (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(60_000);
		await page.emulateMedia({ colorScheme });
		const { view, received } = await openWithCards(page, context, [BASH]);
		const card = view.getByTestId("chat-permission-card");

		await card.getByRole("button", { name: "Deny" }).click();
		const field = card.getByLabel(FIELD);
		await expect(field).toBeFocused();
		await expectNoViolations(page, '[data-testid="chat-permission-card"]');

		await field.press("Escape");
		await expect(card.getByLabel(FIELD)).toHaveCount(0);
		await expect(card.getByRole("button", { name: "Deny" })).toBeFocused();

		await page.keyboard.press("2");
		await card.getByLabel(FIELD).fill("Delete only build/cache");
		await card.getByLabel(FIELD).press("Enter");
		await expect(card).toHaveCount(0);
		expect(received).toEqual([
			{
				type: "permission.answer",
				id: "p1",
				optionId: "deny",
				message: "Delete only build/cache",
			},
		]);
	});

	test(`Back beside Send restores the options after a mistaken Deny (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(60_000);
		await page.emulateMedia({ colorScheme });
		const { view, received } = await openWithCards(page, context, [BASH]);
		const card = view.getByTestId("chat-permission-card");
		await card.getByRole("button", { name: "Deny" }).click();
		const back = card.getByRole("button", { name: "Back" });
		await expect(back).toBeVisible();
		await expectNoViolations(page, '[data-testid="chat-permission-card"]');
		await back.click();
		await expect(card.getByLabel(FIELD)).toHaveCount(0);
		await expect(card.getByRole("button", { name: "Deny" })).toBeFocused();
		await card.getByRole("button", { name: "Allow once" }).click();
		await expect(card).toHaveCount(0);
		expect(received).toEqual([
			{ type: "permission.answer", id: "p1", optionId: "allow" },
		]);
	});

	test(`approving a plan with accept edits switches the mode picker (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(60_000);
		await page.emulateMedia({ colorScheme });
		const { view, received } = await openWithCards(page, context, [PLAN]);
		await expectNoViolations(page, '[data-testid="chat-permission-card"]');
		await view.getByRole("button", { name: "Yes, and accept edits" }).click();
		await expect(view.getByTestId("chat-permission-card")).toHaveCount(0);
		await expect(view.getByTestId("composer-mode")).toContainText("Accept edits");
		expect(received).toEqual([
			{
				type: "permission.answer",
				id: "p2",
				optionId: "allow-accept-edits",
			},
		]);
	});
}

test("No, keep planning sends a plain denial when nothing is typed", async ({
	page,
	context,
}) => {
	test.setTimeout(60_000);
	const { view, received } = await openWithCards(page, context, [PLAN]);
	await view.getByRole("button", { name: "No, keep planning" }).click();
	await view.getByLabel(FIELD).press("Enter");
	await expect(view.getByTestId("chat-permission-card")).toHaveCount(0);
	expect(received).toEqual([{ type: "permission.answer", id: "p2", optionId: "deny" }]);
});

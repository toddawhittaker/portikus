import { expect, type Locator, type Page, test } from "@playwright/test";
import { openChat, openChatOptions, receivedFrames } from "./chat-helpers";
import { createStudent, expectNoViolations } from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * A model or version change in a chat with history asks first (SPEC.md
 * §10.2): the new model reads the whole conversation again at the cache-write
 * price. Change model goes ahead, Start fresh chat with handoff asks for a
 * handoff note, and Cancel leaves the picker on the old model. The fake
 * agent's chats start with one earlier turn.
 */

const WARNING =
	"The new model reads this whole conversation again at full price, about 30k tokens. Starting a fresh chat with a handoff is cheaper.";

async function setContext(id: string, usedTokens: number) {
	const sent = await fetch(`${FAKE_AGENT_URL}/__test/chats/${id}/context`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ usedTokens, windowTokens: 1_000_000, cache: null }),
	});
	expect(sent.ok).toBe(true);
}

async function open(
	page: Page,
	context: Parameters<typeof createStudent>[0],
	agent: "claude" | "codex" = "claude",
) {
	const student = await createStudent(context);
	const chat = await openChat(page, student.workspaceId, "Model change", agent);
	await expect(chat.view.getByText("Earlier answer")).toBeVisible();
	await setContext(chat.id, 30_200);
	await expect(chat.view.getByTestId("composer-context")).toContainText("30.2k");
	await openChatOptions(chat.view);
	return chat;
}

function dialog(page: Page): Locator {
	return page.getByTestId("dialog-model-change");
}

async function pick(
	page: Page,
	view: Locator,
	testId: string,
	option: string | RegExp,
) {
	await view.getByTestId(testId).click();
	await page.getByRole("menuitemradio", { name: option }).click();
}

for (const colorScheme of ["dark", "light"] as const) {
	test(`a model change with history asks first, and Cancel leaves the picker alone (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const { id, view } = await open(page, context);
		await pick(page, view, "composer-model", "Opus");

		const ask = dialog(page);
		await expect(ask).toBeVisible();
		await expect(ask).toHaveAccessibleName("Change the model in this chat?");
		await expect(ask).toHaveAccessibleDescription(WARNING);
		await expect(
			ask.getByRole("button", { name: "Start fresh chat with handoff" }),
		).toBeVisible();
		await expect(ask.getByRole("button", { name: "Change model" })).toBeVisible();
		await expectNoViolations(page, '[data-testid="dialog-model-change"]');
		await page.screenshot({ path: `screenshots/model-change-${colorScheme}.png` });

		await ask.getByRole("button", { name: "Cancel" }).click();
		await expect(ask).toHaveCount(0);
		await expect(view.getByTestId("composer-model")).toHaveText("Model Sonnet");
		expect(await receivedFrames(id, "set")).toEqual([]);
	});
}

test("Escape cancels and focus returns to the Model picker", async ({
	page,
	context,
}) => {
	const { id, view } = await open(page, context);
	await pick(page, view, "composer-model", "Opus");
	await expect(dialog(page)).toBeVisible();
	// Focus moves into the dialog and stays there.
	await expect(dialog(page).locator(":focus")).toHaveCount(1);
	await page.keyboard.press("Escape");
	await expect(dialog(page)).toHaveCount(0);
	await expect(view.getByTestId("composer-model")).toBeFocused();
	await expect(view.getByTestId("composer-model")).toHaveText("Model Sonnet");
	expect(await receivedFrames(id, "set")).toEqual([]);
});

test("Change model sends the change and the picker shows the new model", async ({
	page,
	context,
}) => {
	const { id, view } = await open(page, context);
	await pick(page, view, "composer-model", "Opus");
	await dialog(page).getByRole("button", { name: "Change model" }).click();
	await expect(dialog(page)).toHaveCount(0);
	await expect(view.getByTestId("composer-model")).toHaveText("Model Opus");
	await expect
		.poll(async () => receivedFrames(id, "set"))
		.toEqual([{ type: "set", model: "opus" }]);
});

test("a version change asks too", async ({ page, context }) => {
	const { id, view } = await open(page, context);
	await pick(page, view, "composer-model", "Opus");
	await dialog(page).getByRole("button", { name: "Change model" }).click();
	await expect(view.getByTestId("composer-model")).toHaveText("Model Opus");
	await pick(page, view, "composer-version", "4.8");
	await expect(dialog(page)).toBeVisible();
	await dialog(page).getByRole("button", { name: "Change model" }).click();
	await expect(view.getByTestId("composer-version")).toHaveText("Version 4.8");
	// Focus is back on the picker the choice came from.
	await expect(view.getByTestId("composer-version")).toBeFocused();
	await expect
		.poll(async () => receivedFrames(id, "set"))
		.toEqual([
			{ type: "set", model: "opus" },
			{ type: "set", model: "claude-opus-4-8" },
		]);
});

test("Start fresh chat with handoff asks for the note and changes no model", async ({
	page,
	context,
}) => {
	const { id, view } = await open(page, context);
	await pick(page, view, "composer-model", "Opus");
	await dialog(page)
		.getByRole("button", { name: "Start fresh chat with handoff" })
		.click();
	await expect(dialog(page)).toHaveCount(0);
	await expect(
		view.getByRole("region", { name: "Review the handoff note" }),
	).toBeVisible();
	await expect(view.getByTestId("composer-model")).toHaveText("Model Sonnet");
	expect(await receivedFrames(id, "set")).toEqual([]);
});

test("effort and permission changes ask nothing", async ({ page, context }) => {
	const { id, view } = await open(page, context);
	await pick(page, view, "composer-effort", "Low");
	await expect(view.getByTestId("composer-effort")).toHaveText("Effort Low");
	await pick(page, view, "composer-mode", "Plan");
	await expect(view.getByTestId("composer-mode")).toHaveText("Permissions Plan");
	await expect(dialog(page)).toHaveCount(0);
	await expect
		.poll(async () => receivedFrames(id, "set"))
		.toEqual([
			{ type: "set", effort: "low" },
			{ type: "set", mode: "plan" },
		]);
});

test("a Codex chat with history asks before a model change", async ({
	page,
	context,
}) => {
	const { id, view } = await open(page, context, "codex");
	await pick(page, view, "composer-model", /GPT-5\.4 mini/);
	await expect(dialog(page)).toBeVisible();
	await expect(dialog(page)).toHaveAccessibleDescription(WARNING);
	await dialog(page).getByRole("button", { name: "Change model" }).click();
	await expect(view.getByTestId("composer-model")).toHaveText(/GPT-5\.4 mini/);
	await expect
		.poll(async () => receivedFrames(id, "set"))
		.toEqual([{ type: "set", model: "gpt-5.4-mini" }]);
});

test("an empty chat changes model with no question", async ({ page, context }) => {
	const { id, view } = await open(page, context);
	const box = view.getByTestId("chat-composer-input");
	await box.fill("/clear");
	await box.press("Enter");
	await expect(view.getByText("Earlier answer")).toHaveCount(0);
	await pick(page, view, "composer-model", "Opus");
	await expect(view.getByTestId("composer-model")).toHaveText("Model Opus");
	await expect(dialog(page)).toHaveCount(0);
	await expect
		.poll(async () => receivedFrames(id, "set"))
		.toEqual([{ type: "set", model: "opus" }]);
});

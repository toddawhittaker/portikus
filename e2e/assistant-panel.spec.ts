import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	expectNoViolations,
	lockSharedState,
	openAdmin,
	query,
	WEB_ORIGIN,
} from "./helpers";
import { FAKE_MODEL_PORT } from "./ports";

/**
 * The administrator's assistant panel against the real API and the fake
 * model server (SPEC.md section 20.5): a reply, a read tool, a change card
 * approved, a destructive card locked until its confirmation is typed and
 * then denied, the history after a reload, deleting a conversation, and the
 * plain "not enabled" line. Each test scripts the model with its own words,
 * so parallel workers never pick up each other's steps.
 */

const MODEL = `http://127.0.0.1:${FAKE_MODEL_PORT}`;

/** Held alone: these tests turn the site's one AI settings row on and off. */
const AI_SETTINGS_LOCK = "e2e-ai-settings";

async function script(match: string, steps: unknown[]): Promise<void> {
	const response = await fetch(`${MODEL}/__script`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ match, steps }),
	});
	if (!response.ok)
		throw new Error(`the fake model refused the script: ${response.status}`);
}

/** Bumped with the privacy notice text (packages/contracts ai.ts; e2e cannot import the contracts). */
const AI_NOTICE_VERSION = 1;

/**
 * Save a provider and key and accept the notice, then turn the assistant
 * on or off. The API's AI_TEST_BASE_URL sends the model calls to the fake
 * server whatever base address is saved.
 */
async function setAssistant(page: Page, enabled: boolean): Promise<void> {
	const headers = { origin: WEB_ORIGIN };
	const put = await page.request.put("/admin/ai", {
		headers,
		data: {
			providerKind: "openai-compatible",
			baseUrl: "https://api.openai.com/v1",
			model: "fake-model-1",
			key: "sk-e2e-assistant-WXYZ",
		},
	});
	expect(put.ok(), await put.text()).toBe(true);
	const notice = await page.request.post("/admin/ai/notice", {
		headers,
		data: { noticeVersion: AI_NOTICE_VERSION },
	});
	expect(notice.ok(), await notice.text()).toBe(true);
	const toggle = await page.request.put("/admin/ai", { headers, data: { enabled } });
	expect(toggle.ok(), await toggle.text()).toBe(true);
}

function panelOf(page: Page): Locator {
	return page.getByRole("complementary", { name: "Assistant" });
}

async function openPanel(page: Page): Promise<Locator> {
	await page.getByRole("button", { name: "Assistant" }).click();
	const panel = panelOf(page);
	await expect(panel).toBeVisible();
	return panel;
}

async function ask(panel: Locator, text: string): Promise<void> {
	const box = panel.getByRole("textbox", { name: "Message the assistant" });
	await expect(
		panel.getByTestId("assistant-conv-empty").or(panel.locator(".pk-chat-log")),
	).toBeVisible();
	await box.fill(text);
	await box.press("Enter");
}

const ROW_COLUMNS =
	"enabled, provider_kind, base_url, model, key_sealed, key_hint, monthly_token_cap, conversation_token_budget, notice_version, notice_accepted_by, notice_accepted_at";
let saved: Record<string, unknown> | undefined;
let release: (() => Promise<void>) | undefined;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
	release = await lockSharedState(AI_SETTINGS_LOCK);
	[saved] = await query(`select ${ROW_COLUMNS} from ai_settings where id = 1`);
});
test.afterAll(async () => {
	// Put the row back as the other holder of the lock left it.
	if (saved) {
		const columns = ROW_COLUMNS.split(", ");
		await query(
			`update ai_settings set ${columns.map((c, i) => `${c} = $${i + 1}`).join(", ")} where id = 1`,
			columns.map((c) => saved?.[c]),
		);
	}
	await release?.();
});

test.beforeEach(async ({ page }) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await openAdmin(page);
	await setAssistant(page, true);
});

test("ask, see a reply and a read tool, approve a change, and keyboard focus moves in and back", async ({
	page,
}) => {
	const tag = randomUUID().slice(0, 8);
	await script(`e2e-read-${tag}`, [
		{ toolCalls: [{ name: "users_list", arguments: { query: {} } }] },
		{ text: `Read done ${tag}.` },
	]);
	await script(`e2e-change-${tag}`, [
		{
			toolCalls: [
				{ name: "workspaces_restart", arguments: { path: { id: randomUUID() } } },
			],
		},
		{ text: `Change handled ${tag}.` },
	]);

	const button = page.getByRole("button", { name: "Assistant" });
	const panel = await openPanel(page);
	await expect(
		panel.getByRole("heading", { name: "Assistant", level: 2 }),
	).toBeFocused();
	await panel.getByRole("button", { name: "New conversation" }).click();
	await expect(panel.getByTestId("assistant-note")).toContainText(
		"Conversations are kept 30 days and only you can see them.",
	);

	await ask(panel, `e2e-read-${tag}`);
	await expect(panel.getByText(`Read done ${tag}.`)).toBeVisible({ timeout: 15_000 });
	await expect(panel.locator('[data-testid^="chat-tool-"]').first()).toContainText(
		/users/i,
	);
	await expect(page.getByTestId("assistant-announcer")).toHaveText(
		"The assistant replied.",
	);

	await ask(panel, `e2e-change-${tag}`);
	const card = panel.getByTestId("approval-card");
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card.getByTestId("approval-risk")).toHaveText("Change");
	await expect(card.getByRole("table", { name: "Inputs" })).toBeVisible();
	await expect(card.getByRole("button", { name: /always/i })).toHaveCount(0);
	await expect(card.getByRole("button", { name: "Approve" })).toBeFocused();
	await expectNoViolations(page, "#pk-assistant-panel");
	await card.getByRole("button", { name: "Approve" }).click();
	await expect(card.getByTestId("approval-outcome")).toHaveText("Approved");
	await expect(panel.getByText(`Change handled ${tag}.`)).toBeVisible({
		timeout: 15_000,
	});

	await page.keyboard.press("Escape");
	await expect(panel).toHaveCount(0);
	await expect(button).toBeFocused();
});

test("a destructive card stays locked until typed, a denial is shown, and the history survives a reload", async ({
	page,
}) => {
	const tag = randomUUID().slice(0, 8);
	await script(`e2e-destroy-${tag}`, [
		{
			toolCalls: [{ name: "users_disable", arguments: { path: { id: randomUUID() } } }],
		},
		{ text: `Left alone ${tag}.` },
	]);
	const panel = await openPanel(page);
	await panel.getByRole("button", { name: "New conversation" }).click();
	await ask(panel, `e2e-destroy-${tag}`);

	const card = panel.getByTestId("approval-card");
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card.getByTestId("approval-risk")).toHaveText("Destructive");
	const box = card.getByRole("textbox", { name: /^Type .+ to approve$/ });
	const label = (await card.locator("label").first().textContent()) ?? "";
	const confirmText = label.replace(/^Type /, "").replace(/ to approve$/, "");
	const approve = card.getByRole("button", { name: "Approve" });
	await expect(approve).toBeDisabled();
	await box.fill(confirmText.slice(0, -1));
	await expect(approve).toBeDisabled();
	await box.fill(confirmText.toUpperCase());
	await expect(approve).toBeDisabled();
	await box.fill(confirmText);
	await expect(approve).toBeEnabled();
	await expectNoViolations(page, "#pk-assistant-panel");

	await card.getByRole("button", { name: "Deny" }).click();
	await expect(card.getByTestId("approval-outcome")).toHaveText("Denied");
	await expect(panel.getByText(`Left alone ${tag}.`)).toBeVisible({ timeout: 15_000 });

	await page.reload();
	const again = await openPanel(page);
	await again
		.getByTestId("assistant-conversation")
		.first()
		.getByRole("button")
		.first()
		.click();
	await expect(again.getByText(`Left alone ${tag}.`)).toBeVisible({ timeout: 15_000 });
	await expect(again.getByTestId("chat-decision").first()).toHaveAttribute(
		"data-decision",
		"denied",
	);
});

test("a conversation is deleted behind a confirm", async ({ page }) => {
	const tag = randomUUID().slice(0, 8);
	await script(`e2e-delete-${tag}`, [{ text: `Nothing to see ${tag}.` }]);
	const panel = await openPanel(page);
	await panel.getByRole("button", { name: "New conversation" }).click();
	await ask(panel, `e2e-delete-${tag}`);
	await expect(panel.getByText(`Nothing to see ${tag}.`)).toBeVisible({
		timeout: 15_000,
	});
	await panel.getByTestId("assistant-back").click();

	const rows = panel.getByTestId("assistant-conversation");
	const before = await rows.count();
	await rows.first().getByTestId("assistant-delete").click();
	const confirm = page.getByTestId("assistant-delete-confirm");
	await confirm.getByRole("button", { name: "Delete conversation" }).click();
	await expect(confirm).toHaveCount(0);
	await expect(rows).toHaveCount(before - 1);
	await expect(panel).toBeVisible();
});

test("with the assistant off the panel says so and links to the AI settings", async ({
	page,
}) => {
	await setAssistant(page, false);
	const panel = await openPanel(page);
	await expect(panel.getByTestId("assistant-off")).toContainText("turned off");
	await expect(panel.getByRole("link", { name: "AI settings" })).toHaveAttribute(
		"href",
		"/admin/ai",
	);
	await expect(panel.getByRole("button", { name: "New conversation" })).toHaveCount(0);
	await expectNoViolations(page, "#pk-assistant-panel");
	await setAssistant(page, true);
});

import { expect, type Locator, type Page } from "@playwright/test";
import { lockSharedState, query, WEB_ORIGIN } from "./helpers";
import { FAKE_MODEL_PORT } from "./ports";

/**
 * What the assistant specs share: scripting the fake model server, turning
 * the assistant on, driving the panel, and holding the site's one AI
 * settings row while a spec changes it.
 */

const MODEL = `http://127.0.0.1:${FAKE_MODEL_PORT}`;

/** Held alone: these specs turn the site's one AI settings row on and off. */
const AI_SETTINGS_LOCK = "e2e-ai-settings";

/** Bumped with the privacy notice text (packages/contracts ai.ts; e2e cannot import the contracts). */
const AI_NOTICE_VERSION = 1;

const ROW_COLUMNS =
	"enabled, provider_kind, base_url, model, key_sealed, key_hint, monthly_token_cap, conversation_token_budget, notice_version, notice_accepted_by, notice_accepted_at";

/** Script the fake model: when the last message contains `match`, answer with `steps`, one per model turn. */
export async function script(match: string, steps: unknown[]): Promise<void> {
	const response = await fetch(`${MODEL}/__script`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ match, steps }),
	});
	if (!response.ok)
		throw new Error(`the fake model refused the script: ${response.status}`);
}

/**
 * Take the AI settings lock and remember the row; the function it returns
 * puts the row back as the other holder of the lock left it, then releases.
 */
export async function holdAiSettings(): Promise<() => Promise<void>> {
	const release = await lockSharedState(AI_SETTINGS_LOCK);
	const [saved] = await query(`select ${ROW_COLUMNS} from ai_settings where id = 1`);
	return async () => {
		if (saved) {
			const columns = ROW_COLUMNS.split(", ");
			await query(
				`update ai_settings set ${columns.map((c, i) => `${c} = $${i + 1}`).join(", ")} where id = 1`,
				columns.map((c) => saved[c]),
			);
		}
		await release();
	};
}

/**
 * Save a provider and key and accept the notice, then turn the assistant
 * on or off. The API's AI_TEST_BASE_URL sends the model calls to the fake
 * server whatever base address is saved.
 */
export async function setAssistant(page: Page, enabled: boolean): Promise<void> {
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

export async function openPanel(page: Page): Promise<Locator> {
	await page.getByRole("button", { name: "Assistant" }).click();
	const panel = panelOf(page);
	await expect(panel).toBeVisible();
	return panel;
}

export async function ask(panel: Locator, text: string): Promise<void> {
	const box = panel.getByRole("textbox", { name: "Message the assistant" });
	await expect(
		panel.getByTestId("assistant-conv-empty").or(panel.locator(".pk-chat-log")),
	).toBeVisible();
	await box.fill(text);
	await box.press("Enter");
}

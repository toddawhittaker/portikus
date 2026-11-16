import { randomUUID } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
	createSignedInUser,
	expectNoViolations,
	lockSharedState,
	openAdmin,
	query,
	WEB_ORIGIN,
} from "./helpers";
import { FAKE_MODEL_PORT } from "./ports";

/**
 * The AI settings tab (SPEC.md section 20.4) against the real
 * API and the fake model server, which the API's AI_TEST_BASE_URL points
 * model calls at. The privacy notice gates the switch, the key is write-only,
 * the test round trip shows its stages, the proxy host offer is sent, and the
 * limits save. An instructor gets no AI tab.
 */

const MODEL = `http://127.0.0.1:${FAKE_MODEL_PORT}`;
// The API's test prompt, "Run the portikus_ping check now.", picks this script.
const TEST_MATCH = "portikus_ping";

/** Held alone: these tests change the site's one AI settings row, as the assistant panel's do. */
const AI_SETTINGS_LOCK = "e2e-ai-settings";

async function script(steps: unknown[]): Promise<void> {
	const response = await fetch(`${MODEL}/__script`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ match: TEST_MATCH, steps }),
	});
	if (!response.ok)
		throw new Error(`the fake model refused the script: ${response.status}`);
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
	await query(
		`update ai_settings set enabled = false, provider_kind = null, base_url = null,
		model = null, key_sealed = null, key_hint = null, monthly_token_cap = 5000000,
		conversation_token_budget = 200000, notice_version = null,
		notice_accepted_by = null, notice_accepted_at = null where id = 1`,
	);
	await page.emulateMedia({ colorScheme: "dark" });
	await openAdmin(page);
});

/**
 * Records each settings save and drops `addProxyHost` before it reaches the
 * API: a real offer writes a root site job request, which the site specs'
 * job runner would pick up. What the page sent is what this checks.
 */
async function recordSaves(page: Page): Promise<Record<string, unknown>[]> {
	const bodies: Record<string, unknown>[] = [];
	await page.route("**/admin/ai", async (route) => {
		const request = route.request();
		if (request.method() !== "PUT") return route.fallback();
		const body = request.postDataJSON() as Record<string, unknown>;
		bodies.push(body);
		const { addProxyHost: _, ...rest } = body;
		await route.fallback({ postData: JSON.stringify(rest) });
	});
	return bodies;
}

async function openAi(page: Page) {
	await page.goto("/admin/ai");
	await expect(
		page.getByRole("heading", { level: 2, name: "AI", exact: true }),
	).toBeVisible({ timeout: 15_000 });
}

/** A saved provider and key, and the notice accepted, through the API. */
async function configure(page: Page): Promise<void> {
	const headers = { origin: WEB_ORIGIN };
	const notice = await page.request.post("/admin/ai/notice", {
		headers,
		data: { noticeVersion: 1 },
	});
	expect(notice.ok(), await notice.text()).toBe(true);
	const put = await page.request.put("/admin/ai", {
		headers,
		data: {
			providerKind: "openai-compatible",
			baseUrl: "https://api.openai.com/v1",
			model: "fake-model-1",
			key: "sk-e2e-configured-LMNO",
		},
	});
	expect(put.ok(), await put.text()).toBe(true);
}

test("the notice must be accepted before the switch works", async ({ page }) => {
	await configure(page);
	await query(
		"update ai_settings set notice_version = null, notice_accepted_by = null, notice_accepted_at = null where id = 1",
	);
	await openAi(page);
	const toggle = page.getByRole("switch", { name: /Turn on the assistant/ });
	await expect(toggle).toHaveAttribute("aria-disabled", "true");
	await expect(page.getByTestId("ai-switch-reason")).toHaveText(
		"Read and accept the privacy notice first.",
	);
	// Unavailable but still focusable: Space does nothing.
	await toggle.focus();
	await page.keyboard.press("Space");
	await expect(toggle).not.toBeChecked();

	// The API refuses the switch too, with its own code.
	const refused = await page.request.put("/admin/ai", {
		headers: { origin: WEB_ORIGIN },
		data: { enabled: true },
	});
	expect(refused.status()).toBe(409);
	expect((await refused.json()).code).toBe("AI_NOTICE_REQUIRED");

	const notice = page.getByTestId("ai-notice");
	await expect(notice).toContainText("never sent");
	await expect(notice).toContainText("30 days");
	await expectNoViolations(page, "main");
	await notice.getByRole("button", { name: "I have read this" }).click();
	await expect(page.getByTestId("ai-notice-accepted")).toContainText("Accepted by");
	await expect(notice.getByText("Read the notice again")).toBeVisible();

	await expect(toggle).not.toHaveAttribute("aria-disabled");
	await toggle.click();
	await expect(toggle).toBeChecked();
	await page.reload();
	await expect(page.getByRole("switch", { name: /Turn on the assistant/ })).toBeChecked(
		{
			timeout: 15_000,
		},
	);
});

test("a set key shows only its last four characters, and the proxy offer is sent", async ({
	page,
}) => {
	const saves = await recordSaves(page);
	await openAi(page);
	const provider = page.getByTestId("ai-provider");
	await expect(provider.getByTestId("ai-key-state")).toHaveText("Not set");
	await expect(provider.getByLabel("Base address")).toHaveValue(
		"https://api.openai.com/v1",
	);

	// Anthropic fills its own address; the host offer follows the address (D5).
	await provider.getByRole("combobox", { name: "Kind" }).click();
	await page.getByRole("option", { name: "Anthropic" }).click();
	await expect(provider.getByLabel("Base address")).toHaveValue(
		"https://api.anthropic.com",
	);
	const offer = provider.getByTestId("ai-proxy-offer");
	await expect(offer).toContainText(
		"Portikus will also allow the server to reach api.anthropic.com on port 443",
	);
	await expect(offer.getByRole("checkbox")).toBeChecked();

	const secret = `sk-e2e-${randomUUID()}-WXYZ`;
	await provider.getByLabel("Model").fill("fake-model-1");
	await provider.getByLabel("Key", { exact: true }).fill(secret);
	await provider.getByRole("button", { name: "Save provider" }).click();
	await expect(provider.getByTestId("ai-key-state")).toHaveText("Set, ends in WXYZ");
	expect(saves.at(-1)).toMatchObject({
		providerKind: "anthropic",
		baseUrl: "https://api.anthropic.com",
		addProxyHost: true,
	});

	// The key is never shown back, on the page or in what the API sends.
	await page.reload();
	await expect(page.getByTestId("ai-key-state")).toHaveText("Set, ends in WXYZ", {
		timeout: 15_000,
	});
	expect(await page.content()).not.toContain(secret);
	const view = await page.request.get("/admin/ai");
	expect(await view.text()).not.toContain(secret);
	// The host is added by a root site job, so it shows as not allowed until then.
	await expect(page.getByTestId("ai-proxy-offer")).toBeVisible();

	// Unticked, the offer is not sent.
	await page.getByTestId("ai-proxy-offer").getByRole("checkbox").uncheck();
	await page.getByRole("button", { name: "Save provider" }).click();
	await expect.poll(() => saves.length).toBe(2);
	expect(saves[1]).not.toHaveProperty("addProxyHost");
	expect(saves[1]).not.toHaveProperty("key");
	await expectNoViolations(page, "main");

	await page.getByRole("button", { name: "Clear" }).click();
	await expect(page.getByTestId("ai-key-state")).toHaveText("Not set");
});

test("the test passes all four stages and never shows the reply", async ({ page }) => {
	await configure(page);
	await script([
		{ toolCalls: [{ name: "portikus_ping", arguments: { word: "pong" } }] },
		{ text: "pong" },
	]);
	await openAi(page);
	const group = page.getByTestId("ai-test");
	await group.getByRole("button", { name: "Test" }).click();
	await expect(group.getByTestId("ai-test-message")).toHaveText(
		"The test passed with fake-model-1.",
		{ timeout: 30_000 },
	);
	for (const stage of ["connect", "reply", "tool-call", "tool-result"]) {
		await expect(group.getByTestId(`ai-test-stage-${stage}`)).toHaveAttribute(
			"data-state",
			"done",
		);
	}
	await expect(group).not.toContainText("pong");
	await expectNoViolations(page, "main");
});

test("a key the provider refuses shows the plain auth message", async ({ page }) => {
	await configure(page);
	await script([{ error: 401 }]);
	await openAi(page);
	const group = page.getByTestId("ai-test");
	await group.getByRole("button", { name: "Test" }).click();
	await expect(group.getByTestId("ai-test-message")).toHaveText(
		"The provider refused the key. Check that it is right and still active.",
		{ timeout: 30_000 },
	);
	await expect(group.getByTestId("ai-test-stage-connect")).toHaveAttribute(
		"data-state",
		"failed",
	);
	await expect(group).not.toContainText("fake model error");
});

test("the limits save and this month's use shows against the cap", async ({ page }) => {
	await openAi(page);
	const limits = page.getByTestId("ai-limits");
	await expect(limits.getByRole("meter")).toBeVisible();
	await expect(limits).toContainText("of 5,000,000 tokens");
	const cap = limits.getByLabel("Monthly token cap");
	await expect(cap).toHaveValue("5000000");
	await expect(limits.getByLabel("Budget for each conversation")).toHaveValue("200000");

	await cap.fill("0");
	await limits.getByRole("button", { name: "Save limits" }).click();
	await expect(cap).toHaveAttribute("aria-invalid", "true");
	await expect(cap).toBeFocused();

	await cap.fill("1000000");
	await limits.getByLabel("Budget for each conversation").fill("50000");
	await limits.getByRole("button", { name: "Save limits" }).click();
	await expect(limits).toContainText("of 1,000,000 tokens");
	const [row] = await query<{ cap: string; budget: number }>(
		"select monthly_token_cap as cap, conversation_token_budget as budget from ai_settings where id = 1",
	);
	expect(row).toEqual({ cap: "1000000", budget: 50000 });
});

async function instructorPage(browser: Browser): Promise<Page> {
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	const { userId } = await createSignedInUser(context, "student");
	await query("update users set role = 'instructor' where id = $1", [userId]);
	return context.newPage();
}

test("an instructor gets no AI tab and no AI settings", async ({ browser }) => {
	const page = await instructorPage(browser);
	await page.goto("/admin/ai");
	await expect(page).toHaveURL(/\/not-authorized$/, { timeout: 15_000 });
	await expect(page.getByRole("link", { name: "AI", exact: true })).toHaveCount(0);
	const api = await page.request.get("/admin/ai");
	expect(api.status()).toBe(403);
	await page.context().close();
});

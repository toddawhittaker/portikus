import { mkdirSync } from "node:fs";
import { AI_NOTICE_VERSION } from "@portikus/contracts";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { FAKE_PRICE_ROWS } from "./fake-model-server.mjs";
import {
	createSignedInUser,
	expectNoViolations,
	lockSharedState,
	openAdmin,
	query,
	WEB_ORIGIN,
} from "./helpers";

/**
 * The Model prices tab (SPEC.md sections 10.8 and 20.4) against the real API
 * and the fake model server: a check reads the fake pricing pages and
 * proposes rows, each accepted or rejected on its own; rows are added,
 * edited and deleted by hand; a refused source says so. An instructor gets
 * no tab.
 */

/** The same lock as the AI settings specs: these tests change the one AI settings row. */
const AI_SETTINGS_LOCK = "e2e-ai-settings";
const SHOTS = "/tmp/epic69/t12/shots";

const AI_COLUMNS =
	"enabled, provider_kind, base_url, model, key_sealed, key_hint, monthly_token_cap, conversation_token_budget, notice_version, notice_accepted_by, notice_accepted_at, price_sources";
// In the order rows can be put back: proposals name their run.
const PRICE_TABLES = ["model_prices", "price_runs", "price_proposals"] as const;

// The fake answers each provider's page with its one row; "refuse" in an address gets a 403.
const SOURCES = [
	"https://platform.openai.com/docs/pricing",
	"https://docs.claude.com/en/docs/about-claude/pricing",
	"https://www.anthropic.com/refuse",
];

let savedAi: Record<string, unknown> | undefined;
const savedTables: Partial<Record<(typeof PRICE_TABLES)[number], unknown[]>> = {};
let release: (() => Promise<void>) | undefined;

async function clearPrices() {
	for (const table of [...PRICE_TABLES].reverse()) await query(`DELETE FROM ${table}`);
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
	release = await lockSharedState(AI_SETTINGS_LOCK);
	[savedAi] = await query(`select ${AI_COLUMNS} from ai_settings where id = 1`);
	for (const table of PRICE_TABLES) savedTables[table] = await query(`select * from ${table}`);
	mkdirSync(SHOTS, { recursive: true });
});
test.afterAll(async () => {
	if (savedAi) {
		const columns = AI_COLUMNS.split(", ");
		await query(
			`update ai_settings set ${columns.map((c, i) => `${c} = $${i + 1}`).join(", ")} where id = 1`,
			columns.map((c) => savedAi?.[c]),
		);
	}
	await clearPrices();
	for (const table of PRICE_TABLES) {
		await query(
			`insert into ${table} select * from json_populate_recordset(null::${table}, $1)`,
			[JSON.stringify(savedTables[table] ?? [])],
		);
	}
	await release?.();
});

test.beforeEach(async ({ page }) => {
	await clearPrices();
	await query(
		`update ai_settings set enabled = false, price_sources = $1 where id = 1`,
		[SOURCES],
	);
	await page.emulateMedia({ colorScheme: "dark" });
	await openAdmin(page);
});

/** A saved provider and key, the notice accepted, and the assistant on, through the API. */
async function turnOn(page: Page): Promise<void> {
	const headers = { origin: WEB_ORIGIN };
	const put = await page.request.put("/admin/ai", {
		headers,
		data: {
			providerKind: "openai-compatible",
			baseUrl: "https://api.openai.com/v1",
			model: "fake-model-1",
			key: "sk-e2e-pricing-WXYZ",
		},
	});
	expect(put.ok(), await put.text()).toBe(true);
	const notice = await page.request.post("/admin/ai/notice", {
		headers,
		data: { noticeVersion: AI_NOTICE_VERSION },
	});
	expect(notice.ok(), await notice.text()).toBe(true);
	const on = await page.request.put("/admin/ai", { headers, data: { enabled: true } });
	expect(on.ok(), await on.text()).toBe(true);
}

async function openPricing(page: Page) {
	await page.getByRole("link", { name: "Model prices" }).click();
	await expect(page).toHaveURL(/\/admin\/pricing$/);
	await expect(
		page.getByRole("heading", { level: 2, name: "Model prices", exact: true }),
	).toBeVisible({ timeout: 15_000 });
}

test("a check proposes rows from the source pages; one is accepted and one rejected", async ({
	page,
}) => {
	await turnOn(page);
	await openPricing(page);
	await page.getByTestId("pricing-refresh").click();
	await expect(page.getByTestId("pricing-run-status")).toHaveText("Done", {
		timeout: 60_000,
	});

	// The refused source reads as a sentence and points at the Sources offer.
	const failure = page
		.getByTestId("pricing-run-failures")
		.locator('li[data-code="refused"]');
	await expect(failure).toContainText("www.anthropic.com");
	await expect(failure).toContainText("refused the request");
	await expect(failure.getByRole("link", { name: "Go to Sources" })).toBeVisible();

	const openai = page.getByTestId(`proposal-${FAKE_PRICE_ROWS.openai.model}`);
	const anthropic = page.getByTestId(`proposal-${FAKE_PRICE_ROWS.anthropic.model}`);
	await expect(openai).toContainText("a new row");
	await expect(openai).toContainText(FAKE_PRICE_ROWS.openai.sourceQuote);
	await expect(anthropic).toBeVisible();

	await page.screenshot({ path: `${SHOTS}/proposals-dark.png`, fullPage: true });
	await expectNoViolations(page, "main");
	await page.emulateMedia({ colorScheme: "light" });
	await page.screenshot({ path: `${SHOTS}/proposals-light.png`, fullPage: true });
	await expectNoViolations(page, "main");

	await openai.getByTestId("proposal-accept").click();
	await expect(openai).toHaveCount(0);
	await expect(
		page.getByTestId(`price-row-${FAKE_PRICE_ROWS.openai.model}`),
	).toContainText("$2.00");
	await anthropic.getByTestId("proposal-reject").click();
	await expect(page.getByTestId("pricing-proposals")).toHaveCount(0);
	await expect(
		page.getByTestId(`price-row-${FAKE_PRICE_ROWS.anthropic.model}`),
	).toHaveCount(0);

	const decided = await query<{ model: string; status: string }>(
		"select model, status from price_proposals order by model",
	);
	expect(decided).toEqual([
		{ model: FAKE_PRICE_ROWS.anthropic.model, status: "rejected" },
		{ model: FAKE_PRICE_ROWS.openai.model, status: "accepted" },
	]);
	// The student estimate reads the accepted row from the public table.
	const table = await page.request.get("/pricing");
	expect((await table.json()).prices.map((p: { model: string }) => p.model)).toEqual([
		FAKE_PRICE_ROWS.openai.model,
	]);
});

test("rows are added, edited and deleted by hand", async ({ page }) => {
	await openPricing(page);
	// The assistant is off here, so a check cannot start and the page says why.
	await expect(page.getByTestId("pricing-refresh-reason")).not.toBeEmpty();
	await expect(page.getByText("No prices yet")).toBeVisible();

	await page.getByTestId("price-row-add").click();
	const dialog = page.getByTestId("price-row-dialog");
	await dialog.getByTestId("price-row-save").click();
	await expect(dialog.getByText(/Give the model's name/)).toBeVisible();
	await dialog.getByLabel("Model", { exact: true }).fill("e2e-model-9");
	await dialog.getByLabel(/^Input price/).fill("4");
	await dialog.getByLabel(/^Cache read ratio/).fill("0.1");
	await dialog.getByLabel(/^Cache write ratio/).fill("1.25");
	await dialog
		.getByLabel(/^Source page/)
		.fill("https://docs.claude.com/en/docs/about-claude/pricing");
	await dialog
		.getByLabel(/^Quote from the source/)
		.fill("E2E Model 9: $4 per million input");
	await dialog.getByTestId("price-row-save").click();
	const row = page.getByTestId("price-row-e2e-model-9");
	await expect(row).toContainText("$4.00");

	await page.screenshot({ path: `${SHOTS}/table-dark.png`, fullPage: true });
	await page.emulateMedia({ colorScheme: "light" });
	await page.screenshot({ path: `${SHOTS}/table-light.png`, fullPage: true });
	await page.emulateMedia({ colorScheme: "dark" });

	await row.getByRole("button", { name: "Edit e2e-model-9" }).click();
	await dialog.getByLabel(/^Input price/).fill("4.5");
	await dialog.getByTestId("price-row-save").click();
	await expect(row).toContainText("$4.50");

	await row.getByRole("button", { name: "Delete e2e-model-9" }).click();
	const confirm = page.getByTestId("price-row-delete-dialog");
	await confirm.getByRole("button", { name: "Delete row" }).click();
	await expect(row).toHaveCount(0);
	await expect(page.getByText("No prices yet")).toBeVisible();
});

test("the sources list the saved pages", async ({ page }) => {
	await openPricing(page);
	const list = page.getByTestId("pricing-source-list");
	for (const source of SOURCES) await expect(list).toContainText(source);
	await page.screenshot({ path: `${SHOTS}/sources-dark.png`, fullPage: true });
	await expectNoViolations(page, "main");
	await page.emulateMedia({ colorScheme: "light" });
	await expectNoViolations(page, "main");
	await page.screenshot({ path: `${SHOTS}/sources-light.png`, fullPage: true });
});

async function instructorPage(browser: Browser): Promise<Page> {
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	const { userId } = await createSignedInUser(context, "student");
	await query("update users set role = 'instructor' where id = $1", [userId]);
	return context.newPage();
}

test("an instructor gets no Model prices tab and no admin price routes", async ({
	browser,
}) => {
	const page = await instructorPage(browser);
	await page.goto("/admin/pricing");
	await expect(page).toHaveURL(/\/not-authorized$/, { timeout: 15_000 });
	await expect(page.getByRole("link", { name: "Model prices" })).toHaveCount(0);
	expect((await page.request.get("/admin/pricing")).status()).toBe(403);
	await page.context().close();
});

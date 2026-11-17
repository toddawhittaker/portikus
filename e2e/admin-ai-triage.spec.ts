import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { AI_NOTICE_VERSION } from "../packages/contracts/dist/ai.js";
import {
	expectNoViolations,
	lockSharedState,
	openAdmin,
	query,
	WEB_ORIGIN,
} from "./helpers";

/**
 * Alert explanations on the AI tab and in the notifications dialog (SPEC.md
 * sections 20.4 and 20.5): both switches start off and
 * save, the daily limit takes 0 to 100, the privacy notice is at version 2 and
 * must be read again, an explanation shows as plain text under its alert, and a
 * digest-style notice keeps its line breaks.
 */

/** Held alone: these tests change the site's one AI settings row. */
const AI_SETTINGS_LOCK = "e2e-ai-settings";
const COLUMNS =
	"enabled, provider_kind, base_url, model, key_sealed, key_hint, monthly_token_cap, conversation_token_budget, notice_version, notice_accepted_by, notice_accepted_at, triage_enabled, triage_daily_limit, triage_forward";

let saved: Record<string, unknown> | undefined;
let release: (() => Promise<void>) | undefined;
const seeded: string[] = [];

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
	// Other specs hold the lock for minutes; waiting for it is not a failure.
	test.setTimeout(600_000);
	release = await lockSharedState(AI_SETTINGS_LOCK);
	[saved] = await query(`select ${COLUMNS} from ai_settings where id = 1`);
});
test.afterAll(async () => {
	if (seeded.length > 0)
		await query("delete from notifications where title = any($1)", [seeded]);
	if (saved) {
		const columns = COLUMNS.split(", ");
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
		notice_accepted_by = null, notice_accepted_at = null, triage_enabled = false,
		triage_daily_limit = 5, triage_forward = false where id = 1`,
	);
	await page.emulateMedia({ colorScheme: "dark" });
	await openAdmin(page);
});

async function openAi(page: Page) {
	await page.goto("/admin/ai");
	await expect(
		page.getByRole("heading", { level: 2, name: "AI", exact: true }),
	).toBeVisible({ timeout: 15_000 });
}

async function settings() {
	const [row] = await query<{ on: boolean; limit: number; forward: boolean }>(
		"select triage_enabled as on, triage_daily_limit as limit, triage_forward as forward from ai_settings where id = 1",
	);
	return row;
}

const SWITCH = { explain: "Explain alerts" };
const FORWARD = "Add explanations to email and Pushover alerts";

test("both switches start off, save, and survive a reload", async ({ page }) => {
	await openAi(page);
	const group = page.getByTestId("ai-triage");
	const explain = group.getByRole("switch", { name: SWITCH.explain });
	const forward = group.getByRole("switch", { name: FORWARD });
	await expect(explain).not.toBeChecked();
	await expect(forward).not.toBeChecked();
	// The limit appears only while explaining is on.
	await expect(group.getByLabel("Most explanations a day")).toHaveCount(0);

	await explain.click();
	await expect(explain).toBeChecked();
	await expect(group.getByLabel("Most explanations a day")).toHaveValue("5");
	await forward.click();
	await expect(forward).toBeChecked();
	await expect.poll(settings).toEqual({ on: true, limit: 5, forward: true });
	await expectNoViolations(page, "main");

	await page.reload();
	const again = page.getByTestId("ai-triage");
	await expect(again.getByRole("switch", { name: SWITCH.explain })).toBeChecked({
		timeout: 15_000,
	});
	await expect(again.getByRole("switch", { name: FORWARD })).toBeChecked();

	await again.getByRole("switch", { name: SWITCH.explain }).click();
	await expect(again.getByLabel("Most explanations a day")).toHaveCount(0);
	await expect.poll(settings).toEqual({ on: false, limit: 5, forward: true });
});

test("the daily limit takes 0 to 100 and refuses the rest at its field", async ({
	page,
}) => {
	await query("update ai_settings set triage_enabled = true where id = 1");
	await openAi(page);
	const group = page.getByTestId("ai-triage");
	const limit = group.getByLabel("Most explanations a day");
	await expect(limit).toHaveValue("5");

	for (const bad of ["101", "-1", "2.5", "many", ""]) {
		await limit.fill(bad);
		await group.getByRole("button", { name: "Save daily limit" }).click();
		await expect(limit).toHaveAttribute("aria-invalid", "true");
		await expect(limit).toBeFocused();
		await expect(group).toContainText("Give a whole number from 0 to 100.");
	}
	expect((await settings())?.limit).toBe(5);

	// The API refuses a number the page would never send.
	const refused = await page.request.put("/admin/ai", {
		headers: { origin: WEB_ORIGIN },
		data: { triageDailyLimit: 101 },
	});
	expect(refused.status()).toBe(400);

	for (const good of [0, 100]) {
		await limit.fill(String(good));
		await group.getByRole("button", { name: "Save daily limit" }).click();
		await expect.poll(async () => (await settings())?.limit).toBe(good);
		await expect(limit).not.toHaveAttribute("aria-invalid", "true");
	}
	await page.reload();
	await expect(page.getByLabel("Most explanations a day")).toHaveValue("100", {
		timeout: 15_000,
	});
});

test("saving the daily limit leaves focus where it was (WCAG 2.4.3)", async ({
	page,
}) => {
	await query("update ai_settings set triage_enabled = true where id = 1");
	await openAi(page);
	const group = page.getByTestId("ai-triage");
	const limit = group.getByLabel("Most explanations a day");
	const save = group.getByRole("button", { name: "Save daily limit" });

	await limit.fill("12");
	await limit.press("Enter");
	await expect.poll(async () => (await settings())?.limit).toBe(12);
	await expect(group.getByLabel("Most explanations a day")).toHaveValue("12");
	await expect(limit).toBeFocused();

	await limit.fill("30");
	await save.click();
	await expect.poll(async () => (await settings())?.limit).toBe(30);
	await expect(group.getByLabel("Most explanations a day")).toHaveValue("30");
	await expect(save).toBeFocused();
	await expect(save).not.toHaveAttribute("aria-busy", "true");
});

test("a notice accepted at version 1 must be read and accepted again", async ({
	page,
}) => {
	const headers = { origin: WEB_ORIGIN };
	const accepted = await page.request.post("/admin/ai/notice", {
		headers,
		data: { noticeVersion: AI_NOTICE_VERSION },
	});
	expect(accepted.ok(), await accepted.text()).toBe(true);
	const put = await page.request.put("/admin/ai", {
		headers,
		data: {
			providerKind: "openai-compatible",
			baseUrl: "https://api.openai.com/v1",
			model: "fake-model-1",
			key: "sk-e2e-not-a-secret-triage",
		},
	});
	expect(put.ok(), await put.text()).toBe(true);
	// An upgrade leaves the old acceptance in place at the old version.
	await query("update ai_settings set notice_version = 1 where id = 1");

	await openAi(page);
	const notice = page.getByTestId("ai-notice");
	await expect(notice).toContainText("Read this before turning the assistant on.");
	await expect(notice.getByTestId("ai-notice-alerts")).toContainText(
		"explained without anyone asking",
	);
	await expect(notice.getByTestId("ai-notice-alerts")).toContainText(
		"the alert, the latest health figures and a few recent error lines",
	);
	await expect(notice.getByTestId("ai-notice-alerts")).toContainText(
		"Nothing else is sent",
	);
	await expect(
		page.getByRole("switch", { name: /Turn on the assistant/ }),
	).toHaveAttribute("aria-disabled", "true");
	await expect(page.getByTestId("ai-switch-reason")).toHaveText(
		"Read and accept the privacy notice first.",
	);
	await expectNoViolations(page, "main");
	await page.screenshot({ path: "/tmp/epic70/t5b/shots/ai-notice-v2-dark.png" });

	await notice.getByRole("button", { name: "I have read this" }).click();
	await expect(page.getByTestId("ai-notice-accepted")).toContainText("Accepted by");
	const [row] = await query<{ v: number }>(
		"select notice_version as v from ai_settings where id = 1",
	);
	expect(row?.v).toBe(AI_NOTICE_VERSION);
	await expect(
		page.getByRole("switch", { name: /Turn on the assistant/ }),
	).not.toHaveAttribute("aria-disabled");
});

async function me(page: Page): Promise<string> {
	return (await (await page.request.get("/auth/me")).json()).id;
}

async function seed(
	userId: string,
	tone: string,
	title: string,
	body: string,
	triage: string | null,
): Promise<void> {
	seeded.push(title);
	await query(
		"insert into notifications (user_id, tone, title, body, triage) values ($1, $2, $3, $4, $5)",
		[userId, tone, title, body, triage],
	);
}

async function openNotifications(page: Page) {
	await page.reload();
	await page.getByTestId("notifications-badge").click();
	const dialog = page.getByTestId("dialog-notifications");
	await expect(dialog).toBeVisible();
	return dialog;
}

test("an explanation shows as plain text under its alert, labelled as written by AI", async ({
	page,
}) => {
	const title = `Pool filling ${randomUUID().slice(0, 8)}`;
	const hostile =
		'Likely old snapshots. <script>window.__pwned = true</script> <img src=x onerror="window.__pwned = true"> **not bold**';
	await seed(await me(page), "warning", title, "Pool at 91%.", hostile);
	const dialog = await openNotifications(page);
	const item = dialog.getByTestId("notification").filter({ hasText: title });
	const triage = item.getByTestId("notification-triage");

	await expect(triage).toContainText("Explanation written by AI");
	// Every character is text: the tags and Markdown marks show as typed.
	await expect(triage).toContainText("<script>window.__pwned = true</script>");
	await expect(triage).toContainText("**not bold**");
	await expect(triage.locator("script, img, strong, b")).toHaveCount(0);
	expect(await page.evaluate(() => "__pwned" in window)).toBe(false);
	// One visible line says who wrote it; no landmark repeats it per alert.
	await expect(item.getByRole("region")).toHaveCount(0);
	await expectNoViolations(page, '[data-testid="dialog-notifications"]');
	await page.screenshot({
		path: "/tmp/epic70/t5b/shots/notifications-triage-dark.png",
	});
	await page.emulateMedia({ colorScheme: "light" });
	await expectNoViolations(page, '[data-testid="dialog-notifications"]');
});

test("a notification without an explanation has no block, and a digest keeps its line breaks", async ({
	page,
}) => {
	const plain = `Backup failed ${randomUUID().slice(0, 8)}`;
	const digest = `Weekly digest ${randomUUID().slice(0, 8)}`;
	const lines = [
		"Health: 99% of samples were healthy.",
		"Peak running workspaces: 12 of 20.",
		"Usage: 1,200,000 tokens, about $4.",
	];
	const userId = await me(page);
	await seed(userId, "danger", plain, "The target was full.", null);
	await seed(userId, "neutral", digest, lines.join("\n"), null);
	const dialog = await openNotifications(page);

	await expect(
		dialog
			.getByTestId("notification")
			.filter({ hasText: plain })
			.getByTestId("notification-triage"),
	).toHaveCount(0);

	const item = dialog.getByTestId("notification").filter({ hasText: digest });
	const body = item.locator("p", { hasText: lines[0] });
	// Three short lines stack: the paragraph is three lines tall, not one.
	const { height, lineHeight } = await body.evaluate((el) => ({
		height: el.getBoundingClientRect().height,
		lineHeight: Number.parseFloat(getComputedStyle(el).lineHeight),
	}));
	expect(height).toBeGreaterThanOrEqual(lineHeight * 3 - 1);
	await page.screenshot({
		path: "/tmp/epic70/t5b/shots/notifications-digest-dark.png",
	});
});

import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
	afterReads,
	holdAiSettings,
	panelOf,
	script,
	setAssistant,
	toolBlocks,
} from "./assistant-helpers";
import {
	addSession,
	DEX_ACCOUNT_ISSUER,
	expectNoViolations,
	openAdmin,
	query,
	WEB_ORIGIN,
} from "./helpers";
import { resetSiteStore } from "./site-jobs";

/**
 * Guided setup on the Sign-in tab (SPEC.md sections 20.5 and 24), against
 * the real API and the fake model server: "Help me set this up" opens a
 * read-only conversation about the LMS platforms or single sign-on, its
 * first reads show as tool blocks, a scripted answer follows, and no change
 * card can come of it. An instructor never gets the button or the route.
 * Each script matches words only this file sends.
 */

const SHOTS = process.env.E2E_SHOTS ?? "/tmp/portikus-e2e-shots/setup";
const SOON = { timeout: 15_000 };

let restore: (() => Promise<void>) | undefined;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
	// The wait for another spec holding the settings row counts against this hook.
	test.setTimeout(600_000);
	restore = await holdAiSettings();
});
test.afterAll(async () => {
	await restore?.();
});

test.beforeEach(async ({ page }) => {
	await resetSiteStore();
	await page.emulateMedia({ colorScheme: "dark" });
	await openAdmin(page);
	await setAssistant(page, true);
});

/** Open one read's fold, and return its output text. */
async function outputOf(page: Page, index: number): Promise<string> {
	const panel = panelOf(page);
	const details = toolBlocks(page).nth(index);
	if (!(await details.isVisible())) {
		await panel.locator("summary.pk-chat-worked-summary").first().click();
		await panel.locator("summary.pk-turn-group-summary").first().click();
	}
	await details.locator("summary.pk-chat-tool-summary").click();
	return (await details.getByRole("region", { name: "Output" }).textContent()) ?? "";
}

test("on the LMS platforms group the button opens a read-only setup conversation that reads the platforms, the proxy list and the errors", async ({
	page,
}) => {
	await script(
		"Help me set up the LMS platforms",
		afterReads([{ text: "Setup check: the key-set host is on the proxy list." }]),
	);
	await page.goto("/admin/signin");
	const group = page.getByTestId("admin-signin-lms");
	await expect(group.getByTestId("lms-tool-urls")).toBeVisible(SOON);
	await page.screenshot({ path: `${SHOTS}/lms-group.png` });
	await group
		.getByRole("button", { name: "Help me set this up with LMS platforms" })
		.click();

	const panel = panelOf(page);
	await expect(panel).toBeVisible();
	await expect(panel.getByText("This conversation can only read.")).toBeVisible();
	await expect(
		panel.getByText("Help me set up the LMS platforms", { exact: true }),
	).toBeVisible();
	// The model's instructions stay out of sight.
	await expect(panel.getByText("check the saved values", { exact: false })).toHaveCount(
		0,
	);
	await expect(toolBlocks(page)).toHaveCount(3, SOON);
	await expect(
		panel.getByText("Setup check: the key-set host", { exact: false }),
	).toBeVisible(SOON);
	await expect(panel.getByTestId("approval-card")).toHaveCount(0);
	await expectNoViolations(page, "#pk-assistant-panel");
	await page.screenshot({ path: `${SHOTS}/lms-setup.png` });

	// The first read is the platforms list as the page shows it.
	expect(await outputOf(page, 0)).toContain("keysetUrl");
	const stored = await query<{ context: unknown; read_only: boolean }>(
		"select context, read_only from assistant_conversations where context ->> 'kind' = 'setup' and context ->> 'id' = 'lms' order by created_at desc limit 1",
	);
	expect(stored[0]).toEqual({ context: { kind: "setup", id: "lms" }, read_only: true });
});

test("on the single sign-on group the button reads the sign-in settings, the address and the errors", async ({
	page,
}) => {
	await script(
		"Help me set up single sign-on",
		afterReads([{ text: "Setup check: sign-in matches the guide." }]),
	);
	await page.goto("/admin/signin");
	const group = page.getByTestId("admin-signin-sso");
	await expect(group.getByRole("button", { name: /Help me set this up/ })).toBeVisible(
		SOON,
	);
	await page.screenshot({ path: `${SHOTS}/sso-group.png` });
	await group
		.getByRole("button", { name: "Help me set this up with single sign-on" })
		.click();

	const panel = panelOf(page);
	await expect(panel.getByText("This conversation can only read.")).toBeVisible();
	await expect(toolBlocks(page)).toHaveCount(3, SOON);
	await expect(panel.getByText("Setup check: sign-in matches the guide.")).toBeVisible(
		SOON,
	);
	await expect(panel.getByTestId("approval-card")).toHaveCount(0);
	await page.screenshot({ path: `${SHOTS}/sso-setup.png` });
	// The first read carries the sign-in view, which never holds a secret's value.
	const first = await outputOf(page, 0);
	expect(first).toContain("current");
	expect(first).not.toMatch(/clientSecret"/);
});

test("a change the model tries in a setup conversation is refused with no card", async ({
	page,
}) => {
	await script(
		"Help me set up the LMS platforms",
		afterReads([
			{
				toolCalls: [
					{ name: "run_operation", arguments: { operation: "lms.set", input: {} } },
				],
			},
			{ text: "I can only read; nothing was changed." },
		]),
	);
	await page.goto("/admin/signin");
	await page
		.getByTestId("admin-signin-lms")
		.getByRole("button", { name: /Help me set this up/ })
		.click();
	const panel = panelOf(page);
	await expect(panel.getByText("I can only read; nothing was changed.")).toBeVisible(
		SOON,
	);
	await expect(panel.getByTestId("approval-card")).toHaveCount(0);
	const approvals = await query(
		"select count(*)::int as n from assistant_approvals a join assistant_conversations c on c.id = a.conversation_id where c.context ->> 'kind' = 'setup'",
	);
	expect(approvals[0]?.n).toBe(0);
});

test("with the assistant off the sign-in tab shows no setup button", async ({
	page,
}) => {
	await setAssistant(page, false);
	await page.goto("/admin/signin");
	await expect(
		page.getByTestId("admin-signin-lms").getByTestId("lms-tool-urls"),
	).toBeVisible(SOON);
	await expect(page.getByTestId("diagnose-setup-lms")).toHaveCount(0);
	await expect(page.getByTestId("diagnose-setup-signin")).toHaveCount(0);
	await setAssistant(page, true);
});

test("an instructor sees no setup button and the route refuses a setup conversation", async ({
	browser,
}) => {
	const subject = `e2e-${randomUUID()}`;
	const [row] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role)
		 values ($1, $2, $3, 'E2E Setup Teacher', 'instructor') returning id`,
		[DEX_ACCOUNT_ISSUER, subject, `${subject}@example.edu`],
	);
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		await addSession(context, row?.id ?? "");
		const page = await context.newPage();
		await page.goto("/admin/signin");
		await expect(page.getByTestId("diagnose-setup-lms")).toHaveCount(0);
		await expect(page.getByTestId("diagnose-setup-signin")).toHaveCount(0);
		const refused = await page.request.post("/assistant/conversations", {
			headers: { origin: WEB_ORIGIN },
			data: { context: { kind: "setup", id: "lms" } },
		});
		expect(refused.status()).toBe(403);
	} finally {
		await context.close();
	}
});

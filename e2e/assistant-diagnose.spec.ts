import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
	ask,
	holdAiSettings,
	openPanel,
	script,
	setAssistant,
} from "./assistant-helpers";
import {
	createStudent,
	expectNoViolations,
	openAdmin,
	openDetail,
	query,
	routeApi,
} from "./helpers";

/**
 * Diagnose and the guides (SPEC.md section 20.5), against the real API and
 * the fake model server: a Diagnose button opens a read-only conversation
 * whose fixed reads show as tool blocks before a scripted answer, no card
 * can come of it, and a guide question reads and cites a section. Each
 * script matches words only this file sends.
 */

const SHOTS = "/tmp/epic69/t14/shots";

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
	await page.emulateMedia({ colorScheme: "dark" });
	await openAdmin(page);
	await setAssistant(page, true);
});

const panelOf = (page: Page) => page.getByRole("complementary", { name: "Assistant" });

/** The reads a Diagnose conversation ran, each a tool block, kept in the folded "Worked for" lines. */
const toolBlocks = (page: Page) => panelOf(page).locator("details.pk-chat-tool");

/** Open the folds around the reads: "Worked for" and the group of tool calls inside it. */
async function openReads(page: Page): Promise<void> {
	const panel = panelOf(page);
	await panel.locator("summary.pk-chat-worked-summary").first().click();
	await panel.locator("summary.pk-turn-group-summary").first().click();
}

test("Diagnose on the Health tab shows its reads, then a scripted answer, with no change card", async ({
	page,
}) => {
	await script("likely cause for the site's health?", [
		{
			text: "Likely cause: nothing is failing. The health report and the series agree.",
		},
	]);
	await page.goto("/admin/health");
	await expect(page.getByTestId("health")).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: "Diagnose site health" }).click();

	const panel = panelOf(page);
	await expect(panel).toBeVisible();
	await expect(panel.getByText("This conversation can only read.")).toBeVisible();
	await expect(toolBlocks(page)).toHaveCount(3, { timeout: 15_000 });
	await expect(
		panel.getByText("Likely cause: nothing is failing.", { exact: false }),
	).toBeVisible({ timeout: 15_000 });
	await expect(panel.getByTestId("approval-card")).toHaveCount(0);
	await expect(page.getByTestId("assistant-announcer")).toHaveText(
		"The assistant replied.",
	);
	await page.screenshot({ path: `${SHOTS}/health-diagnose.png` });
	await expectNoViolations(page, "#pk-assistant-panel");

	// The reads open from their fold to the report the route gave.
	await openReads(page);
	await expect(toolBlocks(page).first()).toBeVisible();
	await toolBlocks(page).first().locator("summary.pk-chat-tool-summary").click();
	await expect(
		toolBlocks(page).first().getByRole("region", { name: "Output" }),
	).toContainText("workerStale");
	await page.screenshot({ path: `${SHOTS}/health-reads.png` });
});

test("Diagnose on a workspace reads it, and a change the model tries is refused with no card", async ({
	page,
	browser,
}) => {
	// The model first tries a restart; a read-only conversation is offered no such tool.
	await script("likely cause for this workspace?", [
		{
			toolCalls: [
				{ name: "workspaces_restart", arguments: { path: { id: randomUUID() } } },
			],
		},
		{ text: "I can only read. The workspace is running; nothing is wrong." },
	]);
	const context = await browser.newContext();
	const student = await createStudent(context);
	await context.close();
	const name = `Diag ${randomUUID().slice(0, 8)} Student`;
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	const detail = await openDetail(page, name, "Resources");
	await detail.getByTestId("diagnose-workspace").click();

	const panel = panelOf(page);
	await expect(panel).toBeVisible();
	// Four reads, then the refused restart the model tried.
	await expect(toolBlocks(page)).toHaveCount(5, { timeout: 15_000 });
	await expect(panel.getByText("I can only read.", { exact: false })).toBeVisible({
		timeout: 15_000,
	});
	await expect(panel.getByTestId("approval-card")).toHaveCount(0);
	const approvals = await query(
		"select count(*)::int as n from assistant_approvals a join assistant_conversations c on c.id = a.conversation_id where c.context ->> 'id' = $1",
		[student.workspaceId],
	);
	expect(approvals[0]?.n).toBe(0);
	await page.screenshot({ path: `${SHOTS}/workspace-diagnose.png` });
});

test("Diagnose on an alert in the notifications list reads the notifications and health", async ({
	page,
}) => {
	const me = await (await page.request.get("/auth/me")).json();
	const [row] = await query<{ id: string }>(
		"insert into notifications (user_id, tone, title, body) values ($1, 'danger', $2, 'The thing failed.') returning id",
		[me.id, `Backup failed ${randomUUID().slice(0, 8)}`],
	);
	const id = row?.id ?? "";
	await script(`likely cause for the alert with id ${id}?`, [
		{ text: "Likely cause: the backup target was full." },
	]);
	await page.reload();
	await page.getByTestId("notifications-badge").click();
	const dialog = page.getByTestId("dialog-notifications");
	await expect(dialog).toBeVisible();
	await page.screenshot({ path: `${SHOTS}/alert-list.png` });
	await dialog
		.locator(`[data-notification-id="${id}"]`)
		.getByTestId("diagnose-alert")
		.click();

	await expect(dialog).toHaveCount(0);
	const panel = panelOf(page);
	await expect(panel).toBeVisible();
	await expect(toolBlocks(page)).toHaveCount(3, { timeout: 15_000 });
	await expect(
		panel.getByText("Likely cause: the backup target was full."),
	).toBeVisible({
		timeout: 15_000,
	});
	await page.screenshot({ path: `${SHOTS}/alert-diagnose.png` });
});

test("Diagnose beside a failed site change reads the settings it was changing", async ({
	page,
}) => {
	await script("likely cause for this site change?", [
		{ text: "Likely cause: the proxy refused the host list." },
	]);
	await routeApi(page, "**/admin/proxy-hosts", async (route, request) => {
		const response = await route.fetch();
		if (request.method() !== "GET") return route.fulfill({ response });
		const body = await response.json();
		return route.fulfill({
			response,
			json: {
				...body,
				job: {
					id: randomUUID(),
					kind: "proxy-hosts",
					state: "failed",
					code: "proxy_config_rejected",
					requestedAt: new Date().toISOString(),
					startedAt: new Date().toISOString(),
					finishedAt: new Date().toISOString(),
					trialEndsAt: null,
				},
			},
		});
	});
	await page.goto("/admin/network");
	const group = page.getByTestId("proxy-hosts-group");
	await expect(group.getByText("The proxy refused the change")).toBeVisible({
		timeout: 15_000,
	});
	await group.getByTestId("diagnose-job").click();
	const panel = panelOf(page);
	await expect(toolBlocks(page)).toHaveCount(2, { timeout: 15_000 });
	await expect(
		panel.getByText("Likely cause: the proxy refused the host list."),
	).toBeVisible({ timeout: 15_000 });
});

test("with the assistant off no Diagnose button shows", async ({ page }) => {
	await setAssistant(page, false);
	await page.goto("/admin/health");
	await expect(page.getByTestId("health")).toBeVisible({ timeout: 15_000 });
	await expect(page.getByRole("button", { name: "Assistant" })).toBeVisible();
	await expect(page.getByTestId("diagnose-health")).toHaveCount(0);
	await setAssistant(page, true);
});

test("a question about Portikus reads a guide section and cites it", async ({
	page,
}) => {
	const tag = randomUUID().slice(0, 8);
	const heading =
		/^## (.+)$/m.exec(readFileSync("docs/ADMIN-GUIDE.md", "utf8"))?.[1] ?? "";
	expect(heading).not.toBe("");
	await script(`e2e-guide-${tag}`, [
		{ toolCalls: [{ name: "guide_search", arguments: { query: heading } }] },
		{
			toolCalls: [
				{ name: "guide_read", arguments: { file: "ADMIN-GUIDE.md", heading } },
			],
		},
		{ text: `It is covered in ADMIN-GUIDE.md § ${heading}. ${tag}` },
	]);
	const panel = await openPanel(page);
	await panel.getByRole("button", { name: "New conversation" }).click();
	await ask(panel, `e2e-guide-${tag}`);
	const answer = panel.getByText(`ADMIN-GUIDE.md § ${heading}`, { exact: false });
	await expect(answer.last()).toBeVisible({ timeout: 15_000 });
	await expect(toolBlocks(page)).toHaveCount(2);
	// The read found its section: the second block's output names the heading.
	await openReads(page);
	await toolBlocks(page).nth(1).locator("summary.pk-chat-tool-summary").click();
	await expect(
		toolBlocks(page).nth(1).getByRole("region", { name: "Output" }),
	).toContainText(heading);
	await page.screenshot({ path: `${SHOTS}/guide-answer.png` });
});

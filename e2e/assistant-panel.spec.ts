import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
	ask,
	holdAiSettings,
	openPanel,
	script,
	setAssistant,
} from "./assistant-helpers";
import { expectNoViolations, openAdmin } from "./helpers";

/**
 * The administrator's assistant panel against the real API and the fake
 * model server (SPEC.md section 20.5): a reply, a read tool, a change card
 * approved, a destructive card locked until its confirmation is typed and
 * then denied, the history after a reload, deleting a conversation, and the
 * plain "not enabled" line. Each test scripts the model with its own words,
 * so parallel workers never pick up each other's steps.
 */

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

	const button = page.getByRole("button", { name: "Assistant", exact: true });
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

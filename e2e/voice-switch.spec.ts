/**
 * The administrator's site switch for voice input (SPEC.md §25.10, ADR 0055):
 * off hides every microphone and Settings says why; on brings it back. It
 * writes the one settings row, so it runs alone under both locks.
 */
import { expect, type Page, test } from "@playwright/test";
import {
	lockSharedState,
	loginAs,
	query,
	SETTINGS_ROW_LOCK,
	toast,
	VOICE_SWITCH_LOCK,
} from "./helpers";
import { fakeSpeech, openTerminal } from "./voice-helpers";

test.describe.configure({ mode: "serial" });

const releases: (() => Promise<void>)[] = [];

test.beforeAll(async () => {
	test.setTimeout(600_000);
	releases.push(await lockSharedState(SETTINGS_ROW_LOCK));
	releases.push(await lockSharedState(VOICE_SWITCH_LOCK));
});

test.afterAll(async () => {
	await query("update settings set voice_input_enabled = true where id = 1");
	for (const release of releases.reverse()) await release();
});

async function setVoice(page: Page, on: boolean) {
	await page.goto("/admin/settings");
	const card = page.getByRole("region", { name: "Voice input" });
	const box = card.getByRole("checkbox", { name: /Allow voice input/ });
	await expect(box).toBeEnabled({ timeout: 15_000 });
	await expect(box).toBeChecked({ checked: !on });
	await box.click();
	await expect(toast(page, on ? "Voice input on" : "Voice input off")).toBeVisible();
	await expect(box).toBeChecked({ checked: on });
}

test("an administrator turns voice input off, students see no microphone, and on again brings it back", async ({
	browser,
	page,
	context,
}) => {
	test.setTimeout(120_000);
	const adminContext = await browser.newContext();
	const admin = await adminContext.newPage();
	await loginAs(admin, "carol");
	await setVoice(admin, false);

	const audit = await query<{ metadata: unknown }>(
		"select metadata from audit_events where action = 'settings.voice_input_updated' order by id desc limit 1",
	);
	expect(audit[0]?.metadata).toMatchObject({ from: true, to: false });

	await fakeSpeech(page);
	const id = await openTerminal(page, context);
	await expect(page.getByTestId(`terminal-actions-${id}`)).toBeVisible();
	await expect(page.getByTestId(`terminal-voice-${id}`)).toHaveCount(0);

	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	const dialog = page.getByTestId("dialog-editor-settings");
	await expect(dialog.getByTestId("settings-voice-input")).toHaveText(
		"Your administrator turned voice input off for this site.",
	);

	await setVoice(admin, true);
	await page.reload();
	await expect(page.getByTestId(`terminal-voice-${id}`)).toBeVisible({
		timeout: 15_000,
	});
	await adminContext.close();
});

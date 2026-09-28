import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { OFFSITE_KEY, resetKey, SERVER_KEY } from "./backup-key";
import { loginAs, query, settledAxe, toast, WCAG_TAGS } from "./helpers";

/**
 * The backup key on a server that backs itself up (ADR 0044): the reminder
 * until the first download, the confirmed download, and the upload with its
 * explicit replace step, against the real API and a fake root helper
 * (e2e/fake-backup-key-server.mjs), with the section's automated
 * accessibility checks (SPEC.md section 25.8) at the end. The helper holds
 * one key, so everything that uses it runs here, in order.
 */
test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
	resetKey();
});

async function openTab(page: Page) {
	await loginAs(page, "carol");
	await page.goto("/admin?tab=backups");
	await expect(page.getByTestId("backups-key-group")).toBeVisible();
}

async function keyAudits(action: string) {
	return query<{ result: string; metadata: Record<string, unknown> }>(
		"select result, metadata from audit_events where action = $1 order by id",
		[action],
	);
}

test("the reminder shows until the key is downloaded, and the download is the key file", async ({
	page,
}) => {
	const before = (await keyAudits("backup.key_downloaded")).length;
	await openTab(page);
	await expect(page.getByTestId("backup-key-reminder")).toContainText(
		"Backup key not yet downloaded.",
	);
	await expect(page.getByTestId("backup-key-recipient")).toHaveText(
		SERVER_KEY.recipient,
	);

	await page.getByTestId("backup-key-download").click();
	const dialog = page.getByTestId("backup-key-download-dialog");
	await expect(dialog).toContainText("unlocks every backup of this server");
	await expect(dialog).toContainText("Store it off this server");

	const downloading = page.waitForEvent("download");
	await dialog.getByTestId("dialog-confirm").click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe("portikus-backup-key.txt");
	const path = await download.path();
	expect(await readFile(path, "utf8")).toBe(SERVER_KEY.file);

	await expect(toast(page, "Backup key downloaded")).toBeVisible();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByTestId("backup-key-reminder")).toHaveCount(0);
	await expect(page.getByTestId("backup-key-downloaded")).not.toHaveText("Not yet");

	const rows = await keyAudits("backup.key_downloaded");
	expect(rows).toHaveLength(before + 1);
	expect(rows.at(-1)).toEqual({
		result: "ok",
		metadata: { recipient: SERVER_KEY.recipient },
	});

	// A new visit still knows it was downloaded.
	await page.reload();
	await expect(page.getByTestId("backups-key-group")).toBeVisible();
	await expect(page.getByTestId("backup-key-reminder")).toHaveCount(0);
});

test("the download is sent with no-store", async ({ page }) => {
	await openTab(page);
	await page.getByTestId("backup-key-download").click();
	const answered = page.waitForResponse("**/admin/backups/key/download");
	await page
		.getByTestId("backup-key-download-dialog")
		.getByTestId("dialog-confirm")
		.click();
	const response = await answered;
	expect(response.headers()["cache-control"]).toBe("no-store");
	expect(response.headers()["content-disposition"]).toBe(
		'attachment; filename="portikus-backup-key.txt"',
	);
});

test("uploading another server's key asks before replacing this one", async ({
	page,
}) => {
	await openTab(page);
	await page.getByTestId("backup-key-upload").click();
	const upload = page.getByTestId("backup-key-upload-dialog");
	await upload.getByLabel("Backup key file").setInputFiles({
		name: "portikus-backup-key.txt",
		mimeType: "text/plain",
		buffer: Buffer.from(OFFSITE_KEY.file),
	});
	await upload.getByTestId("dialog-confirm").click();

	const replace = page.getByTestId("backup-key-replace-dialog");
	await expect(replace).toContainText("deletes that key from the server for good");
	// Nothing has changed yet.
	await replace.getByRole("button", { name: "Cancel" }).click();
	await expect(replace).toHaveCount(0);
	await expect(page.getByTestId("backup-key-recipient")).toHaveText(
		SERVER_KEY.recipient,
	);

	await page.getByTestId("backup-key-upload").click();
	await page
		.getByTestId("backup-key-upload-dialog")
		.getByLabel("Backup key file")
		.setInputFiles({
			name: "portikus-backup-key.txt",
			mimeType: "text/plain",
			buffer: Buffer.from(OFFSITE_KEY.file),
		});
	await page
		.getByTestId("backup-key-upload-dialog")
		.getByTestId("dialog-confirm")
		.click();
	await page
		.getByTestId("backup-key-replace-dialog")
		.getByTestId("dialog-confirm")
		.click();

	await expect(toast(page, "Backup key replaced")).toBeVisible();
	await expect(page.getByTestId("backup-key-recipient")).toHaveText(
		OFFSITE_KEY.recipient,
	);
	// An upload is not a download: the reminder stays until a real one.
	await expect(page.getByTestId("backup-key-reminder")).toBeVisible();
	const rows = await keyAudits("backup.key_uploaded");
	expect(rows.slice(-2)).toEqual([
		{ result: "refused", metadata: { reason: "exists" } },
		{
			result: "ok",
			metadata: {
				recipient: OFFSITE_KEY.recipient,
				outcome: "installed",
				replacedRecipient: SERVER_KEY.recipient,
			},
		},
	]);
});

test("a file that is not a key is refused in the dialog", async ({ page }) => {
	await openTab(page);
	await page.getByTestId("backup-key-upload").click();
	const upload = page.getByTestId("backup-key-upload-dialog");
	await upload.getByLabel("Backup key file").setInputFiles({
		name: "notes.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("not a key\n"),
	});
	await upload.getByTestId("dialog-confirm").click();
	await expect(upload.getByRole("alert")).toContainText("not a backup key");
	await expect(page.getByTestId("backup-key-replace-dialog")).toHaveCount(0);
	await upload.getByRole("button", { name: "Cancel" }).click();
	await expect(page.getByTestId("backup-key-recipient")).toHaveText(
		SERVER_KEY.recipient,
	);
});

async function expectNoViolations(page: Page) {
	const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`the key section and its dialogs have no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await openTab(page);
		await expect(page.getByTestId("backup-key-reminder")).toBeVisible();
		await expectNoViolations(page);

		const download = page.getByTestId("backup-key-download");
		await download.click();
		await expect(page.getByTestId("backup-key-download-dialog")).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("backup-key-download-dialog")).toHaveCount(0);
		await expect(download).toBeFocused();

		await page.getByTestId("backup-key-upload").click();
		const upload = page.getByTestId("backup-key-upload-dialog");
		await expect(upload).toBeVisible();
		await expectNoViolations(page);
		// The error, announced and tied to the file field.
		await upload.getByLabel("Backup key file").setInputFiles({
			name: "notes.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("not a key\n"),
		});
		await upload.getByTestId("dialog-confirm").click();
		await expect(upload.getByRole("alert")).toBeVisible();
		await expectNoViolations(page);

		await upload.getByLabel("Backup key file").setInputFiles({
			name: "portikus-backup-key.txt",
			mimeType: "text/plain",
			buffer: Buffer.from(OFFSITE_KEY.file),
		});
		await upload.getByTestId("dialog-confirm").click();
		await expect(page.getByTestId("backup-key-replace-dialog")).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("backup-key-replace-dialog")).toHaveCount(0);
	});
}

import * as crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { expectNoViolations, loginAs, query } from "./helpers";

/**
 * Import from CSV in the Users view (SPEC.md section 5.1, "Add user";
 * section 24.13), against the fake Dex gRPC API (e2e/fake-dex-grpc.mjs).
 * Every test uses its own names, so runs and retries never collide.
 */

function sampleFile(tag: string) {
	const csv = [
		"kind,name,email,username,role",
		`password,Pat ${tag},pat-${tag}@example.edu,pat-${tag},student`,
		`invite,"Iris, ${tag}",iris-${tag}@example.edu,iris-${tag}@tenant.example,instructor`,
		`password,Al ${tag},al-${tag}@example.edu,al-${tag},administrator`,
		`password,Pat Again ${tag},pat-${tag}@example.edu,pat2-${tag},student`,
		"",
	].join("\r\n");
	return { name: "people.csv", mimeType: "text/csv", buffer: Buffer.from(csv) };
}

async function openImport(page: Page) {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: "Import from CSV…" }).click();
	const dialog = page.getByRole("dialog", { name: "Import from CSV" });
	await expect(dialog).toBeVisible();
	return dialog;
}

test("an administrator imports a file, downloads the passwords, and sees the new people", async ({
	page,
}) => {
	const tag = crypto.randomUUID().slice(0, 8);
	const dialog = await openImport(page);

	const sample = page.waitForEvent("download");
	await dialog.getByRole("button", { name: "Download a sample file" }).click();
	expect((await sample).suggestedFilename()).toBe("portikus-accounts-sample.csv");

	await dialog.getByLabel("CSV file").setInputFiles(sampleFile(tag));
	const table = dialog.getByRole("table", { name: "Rows in the file" });
	await expect(table.getByRole("row")).toHaveCount(5);
	await expect(dialog.getByTestId("import-row-4")).toContainText(
		"Administrators cannot be imported.",
	);
	await expect(dialog.getByTestId("import-row-5")).toContainText("Repeats row 2.");
	await expect(dialog.getByTestId("import-summary")).toHaveText(
		"2 rows are ready to add. 2 rows will be skipped.",
	);

	await dialog.getByRole("button", { name: "Add 2 accounts" }).click();
	const done = page.getByRole("dialog", { name: "Import finished" });
	await expect(done.getByTestId("import-result")).toHaveText(
		"1 account added, 1 invitation sent, 2 rows skipped.",
	);
	await expect(done.getByTestId("import-password-warning")).toContainText(
		"will not be shown again",
	);
	const download = page.waitForEvent("download");
	await done.getByRole("button", { name: "Download passwords" }).click();
	const file = await download;
	expect(file.suggestedFilename()).toBe("portikus-one-time-passwords.csv");
	const text = await readFile(await file.path(), "utf8");
	const [header, line, ...rest] = text.trim().split("\r\n");
	expect(header).toBe("name,username,one-time password");
	expect(line).toMatch(new RegExp(`^Pat ${tag},pat-${tag},[A-Za-z0-9]{20}$`));
	expect(rest).toEqual([]);
	await done.getByRole("button", { name: "Done" }).click();
	await expect(done).toBeHidden();

	await page.getByTestId("admin-filter-text").fill(tag);
	const accounts = page.getByTestId("admin-accounts");
	await expect(accounts).toContainText(`Pat ${tag}`);
	await expect(page.getByTestId(`invitation-iris-${tag}@example.edu`)).toBeVisible();

	const [pat] = await query<{ must_change_password: boolean; role: string }>(
		"select must_change_password, role from users where email = $1",
		[`pat-${tag}@example.edu`],
	);
	expect(pat).toEqual({ must_change_password: true, role: "student" });
	const admins = await query("select id from users where email = $1", [
		`al-${tag}@example.edu`,
	]);
	expect(admins).toHaveLength(0);
});

for (const scheme of ["light", "dark"] as const) {
	test(`the import dialog has no automatic violations (${scheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const tag = crypto.randomUUID().slice(0, 8);
		const dialog = await openImport(page);
		await expectNoViolations(page, "[data-testid=import-dialog]");
		await dialog.getByLabel("CSV file").setInputFiles(sampleFile(tag));
		await expect(dialog.getByTestId("import-summary")).toBeVisible();
		await expectNoViolations(page, "[data-testid=import-dialog]");
		await dialog.getByRole("button", { name: "Add 2 accounts" }).click();
		await expect(page.getByTestId("import-result")).toBeVisible();
		await expectNoViolations(page, "[data-testid=import-dialog]");
	});
}

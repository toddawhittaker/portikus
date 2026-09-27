import { expect, type Page, test } from "@playwright/test";
import { loginAs, query, settledAxe, WCAG_TAGS } from "./helpers";

/**
 * Automated accessibility checks (SPEC.md section 25.8) on the admin Network
 * tab and each of its dialogs, in both themes (issue #284). The tab is read
 * as it stands: admin-egress.spec.ts may change the mode meanwhile, so these
 * checks never write the policy.
 */
const SUFFIX = "a11y-egress.test";

test.beforeAll(async () => {
	await query(
		"insert into egress_entries (kind, value, label) values ('host', $1, 'Course API') on conflict (value) do nothing",
		[`api.${SUFFIX}`],
	);
	await query(
		`insert into egress_blocked_names (day, name, source, count)
		 values (current_date, $1, 'dns', 12) on conflict do nothing`,
		[`registry.${SUFFIX}`],
	);
});

test.afterAll(async () => {
	await query("delete from egress_entries where value like $1", [`%${SUFFIX}`]);
	await query("delete from egress_blocked_names where name like $1", [`%${SUFFIX}`]);
});

async function expectNoViolations(page: Page): Promise<void> {
	const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Network tab and its dialogs have no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/admin?tab=network");
		await expect(page.getByTestId("egress-tab")).toBeVisible({ timeout: 15_000 });

		// The tab with a preset's sites open and a test answer showing.
		await page.getByTestId("egress-preset-github").getByText("3 sites").click();
		await page.getByTestId("egress-test-input").fill(`docs.${SUFFIX}`);
		await page.getByTestId("egress-test-run").click();
		await expect(page.getByTestId("egress-test-result")).toBeVisible();
		await expectNoViolations(page);

		// The mode switch's confirmation, for whichever mode is not current.
		const other = page.locator('[data-testid^="egress-mode-"][aria-pressed="false"]');
		await other.click();
		await expect(page.getByTestId("egress-mode-dialog")).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("egress-mode-dialog")).toBeHidden();

		// The entry dialog, with a validation message showing.
		await page.getByTestId("egress-add").click();
		const dialog = page.getByTestId("egress-entry-dialog");
		await dialog.getByTestId("egress-entry-save").click();
		await expect(dialog.getByRole("alert")).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();

		// "Allow…" from the refused names opens the same dialog, filled in.
		await page.getByRole("button", { name: `Allow registry.${SUFFIX}…` }).click();
		await expect(dialog.getByTestId("egress-entry-value")).toHaveValue(
			`registry.${SUFFIX}`,
		);
		await expectNoViolations(page);
		await page.keyboard.press("Escape");

		await page.getByRole("button", { name: `Remove api.${SUFFIX}` }).click();
		await expect(page.getByTestId("egress-remove-dialog")).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("egress-remove-dialog")).toBeHidden();
	});
}

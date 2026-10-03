import { expect, test } from "@playwright/test";
import { expectNoViolations, loginAs, openToggletip, query } from "./helpers";

/**
 * Automated accessibility checks (SPEC.md section 25.8) on the admin Network
 * tab and each of its dialogs, in both themes. The tab is read
 * as it stands: admin-egress.spec.ts may change the mode meanwhile, so these
 * checks never write the policy.
 */
/**
 * Each test seeds and removes its own rows, named for its theme and repeat,
 * so --repeat-each copies never share them. The file runs serially, so the
 * seeding tests never add or delete rows under the unapplied-change check.
 */
test.describe.configure({ mode: "serial" });

async function seed(suffix: string): Promise<void> {
	await query(
		"insert into egress_entries (kind, value, label) values ('host', $1, 'Course API') on conflict (value) do nothing",
		[`api.${suffix}`],
	);
	await query(
		`insert into egress_blocked_names (day, name, source, count)
		 values (current_date, $1, 'dns', 12) on conflict do nothing`,
		[`registry.${suffix}`],
	);
	await query(
		"insert into egress_blocked_entries (value, label) values ($1, 'Games') on conflict (value) do nothing",
		[`games.${suffix}`],
	);
}

async function unseed(suffix: string): Promise<void> {
	await query("delete from egress_entries where value like $1", [`%${suffix}`]);
	await query("delete from egress_blocked_names where name like $1", [`%${suffix}`]);
	await query("delete from egress_blocked_entries where value like $1", [`%${suffix}`]);
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Network tab and its dialogs have no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		// Unique per repeat too, so --repeat-each copies never share rows.
		const suffix = `a11y-egress-${colorScheme}-r${test.info().repeatEachIndex}.test`;
		await unseed(suffix);
		await seed(suffix);
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/admin/network");
		await expect(page.getByTestId("egress-tab")).toBeVisible({ timeout: 15_000 });

		// The tab with a preset's sites open and a test answer showing.
		await page.getByTestId("egress-preset-github").getByText("3 sites").click();
		await page.getByTestId("egress-test-input").fill(`docs.${suffix}`);
		await page.getByTestId("egress-test-run").click();
		await expect(page.getByTestId("egress-test-result")).toBeVisible();
		await expectNoViolations(page);

		// The intro and an open toggletip.
		await expect(page.getByTestId("intro-admin-network")).toBeVisible();
		await page.getByRole("button", { name: "About open and allow-list modes" }).click();
		await expect(openToggletip(page)).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(
			page.getByRole("button", { name: "About open and allow-list modes" }),
		).toBeFocused();

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
		await page.getByRole("button", { name: `Allow registry.${suffix}…` }).click();
		await expect(dialog.getByTestId("egress-entry-value")).toHaveValue(
			`registry.${suffix}`,
		);
		await expectNoViolations(page);
		await page.keyboard.press("Escape");

		// The blocked site dialog, with a validation message showing, and its removal.
		await page.getByTestId("egress-block-add").click();
		const block = page.getByTestId("egress-block-dialog");
		await block.getByTestId("egress-block-save").click();
		await expect(block.getByRole("alert")).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(block).toBeHidden();
		await page.getByRole("button", { name: `Remove games.${suffix}` }).click();
		await expect(page.getByTestId("egress-block-remove-dialog")).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("egress-block-remove-dialog")).toBeHidden();

		await page.getByRole("button", { name: `Remove api.${suffix}` }).click();
		await expect(page.getByTestId("egress-remove-dialog")).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("egress-remove-dialog")).toBeHidden();
		await unseed(suffix);
	});
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Network tab with an unapplied change and no blocked sites has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await page.route("**/admin/egress", async (route) => {
			if (route.request().method() !== "GET") return route.continue();
			const response = await route.fetch();
			const view = await response.json();
			await route.fulfill({
				response,
				json: {
					...view,
					mode: "allow-list",
					blockedSites: [],
					apply: { appliedVersion: view.version - 1, appliedAt: null, error: null },
				},
			});
		});
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/admin/network");
		await expect(
			page
				.getByRole("region", { name: "Internet access from workspaces" })
				.getByText(/^Saved setting:/),
		).toBeVisible({ timeout: 15_000 });
		await expectNoViolations(page);
		// The tab keeps polling; a poll still in the handler when the page closes
		// would fail the test with "Response has been disposed".
		await page.unrouteAll({ behavior: "ignoreErrors" });
	});
}

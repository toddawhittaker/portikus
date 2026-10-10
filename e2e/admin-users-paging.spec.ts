import * as crypto from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { loginAs, MOCK_ISSUER, query, settledAxe, WCAG_TAGS } from "./helpers";

/**
 * The Users view pages on the server (SPEC.md section 20.1): 50 rows a
 * page, search, filters and sort sent to the API, bulk actions on the page
 * in view, and the person pickers still seeing everyone.
 */

const COUNT = 120;

/** 120 students named "Page <tag> 001" to "Page <tag> 120", straight into the database. */
async function seedStudents(tag: string): Promise<void> {
	await query(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role, last_login_at)
		 select $1, 'e2e-' || gen_random_uuid(), 'page-' || $2 || '-' || n || '@example.edu',
		        'Page ' || $2 || ' ' || lpad(n::text, 3, '0'), 'student', now()
		 from generate_series(1, $3::int) as n`,
		[MOCK_ISSUER, tag, COUNT],
	);
}

async function openUsers(page: Page, tag: string): Promise<void> {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("admin-filter-text").fill(`Page ${tag}`);
}

function rowNames(page: Page) {
	return page
		.getByTestId("admin-accounts")
		.getByRole("button", { name: /^Show details for/ });
}

test("120 accounts page 50 at a time, and a page change is announced", async ({
	page,
}) => {
	const tag = crypto.randomUUID().slice(0, 8);
	await seedStudents(tag);
	const asked: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.pathname.endsWith("/admin/users")) asked.push(url.search);
	});
	await openUsers(page, tag);

	await expect(page.getByTestId("admin-account-count")).toHaveText("120 accounts");
	await expect(rowNames(page)).toHaveCount(50);
	await expect(rowNames(page).first()).toHaveText(`Page ${tag} 001`);
	await expect(page.getByTestId("admin-row-count")).toHaveText("Showing 50 of 120");
	await expect(page.getByTestId("admin-page-label")).toHaveText("Page 1 of 3");
	await expect(page.getByTestId("admin-page-previous")).toBeDisabled();

	const announce = page.getByTestId("admin-page-announce");
	await expect(announce).toHaveAttribute("role", "status");
	await page.getByTestId("admin-page-next").click();
	await expect(rowNames(page).first()).toHaveText(`Page ${tag} 051`);
	await expect(rowNames(page)).toHaveCount(50);
	await expect(announce).toHaveText("Page 2 of 3, accounts 51 to 100 of 120");
	await expect(page.getByTestId("admin-page-label")).toHaveText("Page 2 of 3");

	await page.getByTestId("admin-page-next").click();
	await expect(rowNames(page)).toHaveCount(20);
	await expect(rowNames(page).last()).toHaveText(`Page ${tag} 120`);
	await expect(announce).toHaveText("Page 3 of 3, accounts 101 to 120 of 120");
	await expect(page.getByTestId("admin-page-next")).toBeDisabled();

	await page.getByTestId("admin-page-previous").click();
	await expect(rowNames(page).first()).toHaveText(`Page ${tag} 051`);

	// Every table request asked for one page, never the whole list.
	const tableRequests = asked.filter((search) => search.includes("sort="));
	expect(tableRequests.length).toBeGreaterThan(0);
	for (const search of tableRequests) expect(search).toContain("limit=50");
});

test("the pager is accessible", async ({ page }) => {
	const tag = crypto.randomUUID().slice(0, 8);
	await seedStudents(tag);
	await openUsers(page, tag);
	await expect(page.getByTestId("admin-page-label")).toHaveText("Page 1 of 3");
	const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
	expect(results.violations).toEqual([]);
	await expect(page.getByRole("navigation", { name: "Users pages" })).toBeVisible();
});

test("search, sort and filters run on the server and return to page one", async ({
	page,
}) => {
	const tag = crypto.randomUUID().slice(0, 8);
	await seedStudents(tag);
	await openUsers(page, tag);
	await page.getByTestId("admin-page-next").click();
	await expect(rowNames(page).first()).toHaveText(`Page ${tag} 051`);

	// Ten names match, so they fit on one page and the pager goes.
	await page.getByTestId("admin-filter-text").fill(`Page ${tag} 07`);
	await expect(rowNames(page)).toHaveCount(10);
	await expect(rowNames(page).first()).toHaveText(`Page ${tag} 070`);
	await expect(page.getByTestId("admin-account-count")).toHaveText("10 accounts");
	await expect(page.getByTestId("admin-page-next")).toHaveCount(0);

	// The sort reaches names that were never on the first page.
	await page.getByTestId("admin-filter-text").fill(`Page ${tag}`);
	await expect(page.getByTestId("admin-page-label")).toHaveText("Page 1 of 3");
	const table = page.getByTestId("admin-accounts");
	await table.getByRole("button", { name: "Account", exact: true }).click();
	await expect(rowNames(page).first()).toHaveText(`Page ${tag} 120`);

	// A role filter with no match empties the table and the pager.
	await page.getByTestId("admin-filter-role").selectOption("administrator");
	await expect(rowNames(page)).toHaveCount(0);
	await expect(page.getByText("No accounts match.")).toBeVisible();
});

test("bulk actions act on the ticked rows of the page in view only", async ({
	page,
}) => {
	const tag = crypto.randomUUID().slice(0, 8);
	await seedStudents(tag);
	await openUsers(page, tag);
	await page.getByRole("checkbox", { name: `Select Page ${tag} 001` }).check();
	await expect(page.getByTestId("bulk-actions")).toContainText("1 selected");

	await page.getByTestId("admin-page-next").click();
	await expect(rowNames(page).first()).toHaveText(`Page ${tag} 051`);
	await expect(page.getByTestId("bulk-actions")).toHaveCount(0);

	await page.getByRole("checkbox", { name: "Select all shown accounts" }).check();
	await expect(page.getByTestId("bulk-actions")).toContainText("50 selected");
	await page.getByTestId("bulk-disable").click();
	const dialog = page.getByRole("alertdialog");
	await expect(dialog).toContainText("Disable 50 accounts?");
	await dialog.getByRole("button", { name: "Disable" }).click();
	// Fifty accounts are disabled one request at a time.
	await expect(page.getByTestId("bulk-result")).toContainText("Disabled", {
		timeout: 60_000,
	});

	// Only the second page's accounts were disabled.
	const [{ disabled }] = await query<{ disabled: string }>(
		"select count(*) as disabled from users where display_name like $1 and disabled_at is not null",
		[`Page ${tag} %`],
	);
	expect(Number(disabled)).toBe(50);
	const [{ first }] = await query<{ first: string }>(
		"select count(*) as first from users where display_name = $1 and disabled_at is not null",
		[`Page ${tag} 001`],
	);
	expect(Number(first)).toBe(0);
});

test("the person pickers still list everyone, not just one page", async ({ page }) => {
	const tag = crypto.randomUUID().slice(0, 8);
	await seedStudents(tag);
	await loginAs(page, "carol");
	await page.goto("/admin/audit");
	const person = page.getByRole("combobox", { name: "Person" });
	const name = `Page ${tag} 120`;
	// The 120th name is on page three of the Users table, yet the picker has it.
	await expect(page.locator(`#audit-people option[value="${name}"]`)).toBeAttached();
	await person.fill(name.toLowerCase());
	await page.getByRole("button", { name: "Apply filters" }).click();
	await expect(page).toHaveURL(/user=[0-9a-f-]{36}/);
	await expect(person).toHaveValue(name);
});

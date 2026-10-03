import * as crypto from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { loginAs, MOCK_ISSUER, query, toast } from "./helpers";

/**
 * The admin tables (SPEC.md sections 20.1 and 25.8): sortable column
 * headers by mouse and keyboard, and the per-row menu on Users.
 */

async function insertStudent(name: string, state: string | null): Promise<string> {
	const [row] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role, last_login_at)
		 values ($1, $2, $3, $4, 'student', now()) returning id`,
		[
			MOCK_ISSUER,
			`e2e-${crypto.randomUUID()}`,
			`${crypto.randomUUID()}@example.edu`,
			name,
		],
	);
	if (!row) throw new Error("could not create the user");
	if (state) {
		const workspace = crypto.randomUUID();
		await query(
			`insert into workspaces (id, owner_user_id, label, incus_instance_name, state, desired_state)
			 values ($1, $2, $3, $4, $5, $5)`,
			[
				workspace,
				row.id,
				`ws-${workspace.slice(0, 8)}`,
				`ws-${workspace.replace(/-/g, "").slice(0, 24)}`,
				state,
			],
		);
	}
	return row.id;
}

async function openUsers(page: Page, filter: string) {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("admin-filter-text").fill(filter);
}

function names(page: Page) {
	return page
		.getByTestId("admin-accounts")
		.getByRole("button", { name: /^Show details for/ });
}

test("Users columns sort by mouse and by keyboard", async ({ page }) => {
	const tag = crypto.randomUUID().slice(0, 8);
	await insertStudent(`Sort ${tag} Ann`, "running");
	await insertStudent(`Sort ${tag} Bea`, null);
	await insertStudent(`Sort ${tag} Cal`, "stopped");
	await openUsers(page, `Sort ${tag}`);
	const short = (list: string[]) => list.map((name) => name.split(" ").at(-1));
	await expect(names(page)).toHaveCount(3);
	expect(short(await names(page).allTextContents())).toEqual(["Ann", "Bea", "Cal"]);

	const table = page.getByTestId("admin-accounts");
	const account = table.getByRole("columnheader", { name: /^Account/ });
	await expect(account).toHaveAttribute("aria-sort", "ascending");

	// The polite region is there before any press, and says nothing yet.
	const announce = page.getByTestId("admin-sort-announce");
	await expect(announce).toHaveAttribute("role", "status");
	await expect(announce).toHaveText("");

	// Mouse: a second press on the sorted column flips it.
	await table.getByRole("button", { name: "Account", exact: true }).click();
	await expect(account).toHaveAttribute("aria-sort", "descending");
	expect(short(await names(page).allTextContents())).toEqual(["Cal", "Bea", "Ann"]);
	await expect(announce).toHaveText("Sorted by Account, descending");

	// Keyboard: Tab past the column's help button to the next header, and press it.
	await table.getByRole("button", { name: "Account", exact: true }).focus();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Tab");
	await expect(table.getByRole("button", { name: "Role", exact: true })).toBeFocused();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Tab");
	const workspace = table.getByRole("button", { name: "Workspace", exact: true });
	await expect(workspace).toBeFocused();
	// An unsorted header says it sorts, and shows its faint chevron while focused.
	await expect(workspace).toHaveAccessibleDescription("Sort by this column");
	const hint = table
		.getByRole("columnheader", { name: /^Workspace/ })
		.locator(".pk-table-sort-hint");
	await expect(hint).toHaveCSS("opacity", "1");
	await expect(
		table.getByRole("columnheader", { name: /^Role/ }).locator(".pk-table-sort-hint"),
	).toHaveCSS("opacity", "0");
	await page.keyboard.press("Enter");
	await expect(announce).toHaveText("Sorted by Workspace, ascending");
	await expect(workspace).toHaveAccessibleDescription("");
	const workspaceHeader = table.getByRole("columnheader", { name: /^Workspace/ });
	await expect(workspaceHeader).toHaveAttribute("aria-sort", "ascending");
	await expect(account).not.toHaveAttribute("aria-sort", /./);
	// Running, then Stopped; no workspace stays last either way.
	expect(short(await names(page).allTextContents())).toEqual(["Ann", "Cal", "Bea"]);
	// A repeat press on the same header is announced too.
	await page.keyboard.press("Space");
	await expect(announce).toHaveText("Sorted by Workspace, descending");
	await expect(workspaceHeader).toHaveAttribute("aria-sort", "descending");
	expect(short(await names(page).allTextContents())).toEqual(["Cal", "Ann", "Bea"]);
	await expect(workspace).toBeFocused();
	await expect(table.locator("caption")).toContainText(
		"sorted by Workspace, descending",
	);
});

test("the Users toolbar row says what it is for until accounts are ticked", async ({
	page,
}) => {
	const tag = crypto.randomUUID().slice(0, 8);
	await insertStudent(`Hint ${tag} Ann`, null);
	await openUsers(page, `Hint ${tag}`);
	await expect(names(page)).toHaveCount(1);
	const toolbar = page.getByTestId("admin-table-toolbar");
	const hint = toolbar.getByTestId("bulk-hint");
	await expect(hint).toHaveText("Select accounts to act on several at once.");
	// Filtered, the count comes first and the hint follows on the same line.
	const count = page.getByTestId("admin-row-count");
	await expect(count).toHaveText(/^Showing 1 of \d+$/);
	const [countBox, hintBox] = [await count.boundingBox(), await hint.boundingBox()];
	if (!countBox || !hintBox) throw new Error("the toolbar text has no box");
	expect(hintBox.x).toBeGreaterThan(countBox.x + countBox.width);
	expect(Math.abs(hintBox.y - countBox.y)).toBeLessThan(2);

	await page.getByRole("checkbox", { name: `Select Hint ${tag} Ann` }).check();
	await expect(toolbar.getByTestId("bulk-actions")).toContainText("1 selected");
	await expect(hint).toHaveCount(0);
});

test("a Users row menu opens, acts on that account, and gives focus back", async ({
	page,
}) => {
	const tag = crypto.randomUUID().slice(0, 8);
	const name = `Menu ${tag} Dee`;
	const id = await insertStudent(name, "stopped");
	await openUsers(page, `Menu ${tag}`);
	await expect(names(page)).toHaveCount(1);

	// Mouse: open and close with Escape; focus goes back to the button.
	const trigger = page.getByRole("button", { name: `Actions for ${name}` });
	await trigger.click();
	const menu = page.getByRole("menu", { name: `Actions for ${name}` });
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("menuitem")).toHaveText([
		"Start",
		"Rebuild workspace…",
		"Archive workspace…",
		"Disable account…",
	]);
	await page.keyboard.press("Escape");
	await expect(menu).toBeHidden();
	await expect(trigger).toBeFocused();

	// Start runs straight away, like the detail panel's button.
	await trigger.click();
	await menu.getByRole("menuitem", { name: "Start" }).click();
	await expect(toast(page, `Asked to start ${name}'s workspace`)).toBeVisible();
	await expect(trigger).toBeFocused();

	// Keyboard: open with Enter, End to the last item, Enter to choose it.
	await page.keyboard.press("Enter");
	await expect(menu).toBeVisible();
	await page.keyboard.press("End");
	await expect(menu.getByRole("menuitem", { name: "Disable account…" })).toBeFocused();
	await page.keyboard.press("Enter");
	const dialog = page.getByRole("alertdialog", { name: "Disable 1 account?" });
	await expect(dialog.getByTestId("bulk-dialog-names")).toHaveText(`${name}.`);
	await dialog.getByRole("button", { name: "Disable" }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByTestId("bulk-result")).toHaveText(`Disabled ${name}.`);
	await expect(trigger).toBeFocused();
	const [row] = await query<{ disabled_at: Date | null }>(
		"select disabled_at from users where id = $1",
		[id],
	);
	expect(row?.disabled_at).not.toBeNull();

	// The menu follows the account: a disabled one offers Enable instead.
	await page.keyboard.press("Enter");
	await expect(menu.getByRole("menuitem", { name: "Enable account…" })).toBeVisible();
	await expect(menu.getByRole("menuitem", { name: "Disable account…" })).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(trigger).toBeFocused();
});

test("the Audit table's Time column flips the page's order by mouse and keyboard", async ({
	page,
}) => {
	// Three events of one target, a second apart, so the filtered page is known.
	const target = crypto.randomUUID();
	await query(
		`insert into audit_events (actor, target, action, result, metadata, at)
		 select 'system', $1, 'workspace.stop_requested', 'success',
		        jsonb_build_object('n', n), now() - make_interval(secs => 3 - n)
		 from generate_series(1, 3) as n
		 order by n`,
		[target],
	);
	await loginAs(page, "carol");
	await page.goto(`/admin/audit?workspace=${target}`);
	const table = page.getByTestId("audit-table");
	const rows = table.locator("tbody tr");
	await expect(rows).toHaveCount(3, { timeout: 15_000 });
	const firstId = async () =>
		Number((await rows.first().getAttribute("data-testid"))?.replace("audit-row-", ""));
	const newest = await firstId();
	const header = table.getByRole("columnheader", { name: "Time" });
	await expect(header).toHaveAttribute("aria-sort", "descending");
	// Only Time sorts: one page of a long history.
	await expect(table.locator("thead button.pk-table-sort")).toHaveCount(1);

	const announce = page.getByTestId("audit-sort-announce");
	await table.getByRole("button", { name: "Time" }).click();
	await expect(header).toHaveAttribute("aria-sort", "ascending");
	expect(await firstId()).toBeLessThan(newest);
	await expect(table).toHaveAccessibleName(/oldest first/);
	await expect(announce).toHaveText("Sorted by Time, ascending");

	await page.keyboard.press("Enter");
	await expect(header).toHaveAttribute("aria-sort", "descending");
	expect(await firstId()).toBe(newest);
	await expect(announce).toHaveText("Sorted by Time, descending");
});

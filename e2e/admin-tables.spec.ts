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

	// Mouse: a second press on the sorted column flips it.
	await table.getByRole("button", { name: "Account", exact: true }).click();
	await expect(account).toHaveAttribute("aria-sort", "descending");
	expect(short(await names(page).allTextContents())).toEqual(["Cal", "Bea", "Ann"]);

	// Keyboard: Tab past the column's help button to the next header, and press it.
	await table.getByRole("button", { name: "Account", exact: true }).focus();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Tab");
	await expect(table.getByRole("button", { name: "Role", exact: true })).toBeFocused();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Tab");
	const workspace = table.getByRole("button", { name: "Workspace", exact: true });
	await expect(workspace).toBeFocused();
	await page.keyboard.press("Enter");
	const workspaceHeader = table.getByRole("columnheader", { name: /^Workspace/ });
	await expect(workspaceHeader).toHaveAttribute("aria-sort", "ascending");
	await expect(account).not.toHaveAttribute("aria-sort", /./);
	// Running, then Stopped; no workspace stays last either way.
	expect(short(await names(page).allTextContents())).toEqual(["Ann", "Cal", "Bea"]);
	await page.keyboard.press("Space");
	await expect(workspaceHeader).toHaveAttribute("aria-sort", "descending");
	expect(short(await names(page).allTextContents())).toEqual(["Cal", "Ann", "Bea"]);
	await expect(workspace).toBeFocused();
	await expect(table.locator("caption")).toContainText(
		"sorted by Workspace, descending",
	);
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

	await table.getByRole("button", { name: "Time" }).click();
	await expect(header).toHaveAttribute("aria-sort", "ascending");
	expect(await firstId()).toBeLessThan(newest);
	await expect(table).toHaveAccessibleName(/oldest first/);

	await page.keyboard.press("Enter");
	await expect(header).toHaveAttribute("aria-sort", "descending");
	expect(await firstId()).toBe(newest);
});

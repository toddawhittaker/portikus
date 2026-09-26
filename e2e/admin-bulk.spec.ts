import * as crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import { FAKE_AGENT_TOKEN, loginAs, MOCK_ISSUER, query, settledAxe } from "./helpers";

/**
 * Bulk actions on the Users view (Epic 13.1 T4): tick rows, confirm a
 * dialog that names each one, and each row's own admin route is called.
 */

async function insertStudent(name: string): Promise<string> {
	const [row] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role)
		 values ($1, $2, $3, $4, 'student') returning id`,
		[
			MOCK_ISSUER,
			`e2e-${crypto.randomUUID()}`,
			`${crypto.randomUUID()}@example.edu`,
			name,
		],
	);
	if (!row) throw new Error("could not create the user");
	return row.id;
}

test("an administrator disables two accounts at once", async ({ page }) => {
	const tag = crypto.randomUUID().slice(0, 8);
	const first = `Bulk ${tag} One`;
	const second = `Bulk ${tag} Two`;
	const ids = [await insertStudent(first), await insertStudent(second)];

	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("admin-filter-text").fill(`Bulk ${tag}`);
	await expect(page.locator("[data-testid^=account-row-]")).toHaveCount(2);

	// Select all by keyboard.
	await page.getByRole("checkbox", { name: "Select all shown accounts" }).focus();
	await page.keyboard.press("Space");
	await expect(page.getByRole("checkbox", { name: `Select ${first}` })).toBeChecked();
	await expect(page.getByRole("checkbox", { name: `Select ${second}` })).toBeChecked();

	const bar = page.getByTestId("bulk-actions");
	await expect(bar).toContainText("2 selected");
	await expect(bar.getByRole("button", { name: "Enable…" })).toHaveCount(0);
	await bar.getByRole("button", { name: "Disable…" }).click();

	const dialog = page.getByRole("alertdialog", { name: "Disable 2 accounts?" });
	await expect(dialog.getByTestId("bulk-dialog-names")).toHaveText(
		`${first} and ${second}.`,
	);
	expect(
		(
			await (await settledAxe(page)).withTags(["wcag2a", "wcag2aa"]).analyze()
		).violations.map((v) => v.id),
	).toEqual([]);
	await dialog.getByRole("button", { name: "Disable" }).click();

	await expect(page.getByTestId("bulk-result")).toHaveText(
		`Disabled ${first} and ${second}.`,
	);
	// The bar and dialog are gone, so focus sits on the summary, not the page body.
	await expect(page.getByTestId("bulk-result")).toBeFocused();
	expect(await page.evaluate(() => document.activeElement === document.body)).toBe(
		false,
	);
	const rows = await query<{ disabled_at: Date | null }>(
		"select disabled_at from users where id = any($1)",
		[ids],
	);
	expect(rows.every((row) => row.disabled_at !== null)).toBe(true);
	for (const id of ids) {
		await expect(
			page.getByTestId(`account-row-${id}`).getByText("Disabled", { exact: true }),
		).toBeVisible();
	}
});

async function insertWorkspace(userId: string, state: string): Promise<string> {
	const id = crypto.randomUUID();
	const short = id.replace(/-/g, "");
	await query(
		`insert into workspaces
		   (id, owner_user_id, label, incus_instance_name, state, desired_state,
		    agent_address, agent_token)
		 values ($1, $2, $3, $4, $5, $5, '127.0.0.1', $6)`,
		[
			id,
			userId,
			`ws-${short.slice(0, 8)}`,
			`ws-${short.slice(0, 24)}`,
			state,
			`${FAKE_AGENT_TOKEN}:${id}`,
		],
	);
	return id;
}

test("an administrator rebuilds several workspaces at once (SPEC.md section 20.1)", async ({
	page,
}) => {
	const tag = crypto.randomUUID().slice(0, 8);
	const names = [`Rebuild ${tag} One`, `Rebuild ${tag} Two`, `Rebuild ${tag} Three`];
	const users = [];
	for (const name of names) users.push(await insertStudent(name));
	const workspaces = [
		await insertWorkspace(users[0] as string, "running"),
		await insertWorkspace(users[1] as string, "stopped"),
		await insertWorkspace(users[2] as string, "stopped"),
	];
	// The third already waits on an operation, so the route answers 409.
	await query(
		"update workspaces set pending_operation = 'reset-docker' where id = $1",
		[workspaces[2]],
	);

	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("admin-filter-text").fill(`Rebuild ${tag}`);
	await expect(page.locator("[data-testid^=account-row-]")).toHaveCount(3);
	await page.getByRole("checkbox", { name: "Select all shown accounts" }).check();
	await page.getByTestId("bulk-rebuild").click();

	const dialog = page.getByRole("alertdialog", { name: "Rebuild 3 workspaces?" });
	await expect(dialog).toContainText("so do Docker images and volumes");
	await expect(dialog).toContainText(`${names[0]} is running and will restart.`);
	await expect(
		dialog.getByRole("checkbox", { name: "Also reset Docker" }),
	).not.toBeChecked();
	expect(
		(
			await (await settledAxe(page)).withTags(["wcag2a", "wcag2aa"]).analyze()
		).violations.map((v) => v.id),
	).toEqual([]);
	await dialog.getByRole("button", { name: "Rebuild" }).click();

	const result = page.getByTestId("bulk-result");
	await expect(result).toContainText(
		`Rebuild requested for ${names[0]} and ${names[1]}.`,
	);
	await expect(result).toContainText(`Skipped ${names[2]}`);
	const rows = await query<{ id: string; pending_operation: string | null }>(
		"select id, pending_operation from workspaces where id = any($1)",
		[workspaces],
	);
	const byId = new Map(rows.map((row) => [row.id, row.pending_operation]));
	expect(byId.get(workspaces[0] as string)).toBe("rebuild");
	expect(byId.get(workspaces[1] as string)).toBe("rebuild");
	expect(byId.get(workspaces[2] as string)).toBe("reset-docker");
	const audit = await query<{ target: string }>(
		"select target from audit_events where action = 'workspace.rebuild_requested' and target = any($1)",
		[workspaces.map(String)],
	);
	expect(audit.map((row) => row.target).sort()).toEqual(
		[workspaces[0], workspaces[1]].sort(),
	);
});

test("Rebuild all on older images offers exactly the older rows", async ({ page }) => {
	const tag = crypto.randomUUID().slice(0, 8);
	const oldName = `Older ${tag} Old`;
	const newName = `Older ${tag} New`;
	const oldWs = await insertWorkspace(await insertStudent(oldName), "stopped");
	await insertWorkspace(await insertStudent(newName), "stopped");
	// Image currency comes from the worker's host sample, which e2e has none of
	// (the API test covers it), so mark the rows in the list answer.
	await page.route("**/admin/users", async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		for (const user of body.users) {
			if (!user.workspace) continue;
			user.workspace.image.current = user.workspace.id !== oldWs;
		}
		await route.fulfill({ response, json: body });
	});

	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("rebuild-older")).toHaveCount(0);
	await page.getByTestId("admin-filter-text").fill(`Older ${tag}`);
	await page.getByTestId("admin-filter-image").selectOption("older");
	await expect(page.locator("[data-testid^=account-row-]")).toHaveCount(1);
	await page.getByRole("button", { name: "Rebuild all on older images…" }).click();

	const dialog = page.getByRole("alertdialog", { name: "Rebuild 1 workspace?" });
	await expect(dialog.getByTestId("bulk-dialog-names")).toHaveText(`${oldName}.`);
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
});

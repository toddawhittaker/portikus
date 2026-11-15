import { randomBytes, randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { DEX_ACCOUNT_ISSUER, openAdmin, query, routeApi, toast } from "./helpers";

/**
 * The admin API keys tab (SPEC.md sections 24.8 and 24.13): every key with
 * its owner, filtered by person, and expire or revoke for one key, one
 * person's keys, or every key, each behind a confirm that says how many keys
 * it reaches. Keys are seeded for instructors of this test's own, so
 * parallel tests never touch them.
 */

/** An instructor with keys in the given states; returns the instructor's name. */
async function instructorWithKeys(
	states: ("active" | "expired" | "revoked")[],
): Promise<{ name: string; keys: string[] }> {
	const tag = randomUUID().slice(0, 8);
	const name = `Keyholder ${tag}`;
	const [user] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role)
		 values ($1, $2, $3, $4, 'instructor') returning id`,
		[DEX_ACCOUNT_ISSUER, `e2e-${tag}`, `${tag}@example.edu`, name],
	);
	if (!user) throw new Error("could not create the instructor");
	const keys: string[] = [];
	for (const [index, state] of states.entries()) {
		const keyName = `${tag} key ${index + 1}`;
		await query(
			`insert into api_keys (user_id, name, token_hash, display_prefix, scope,
			   period_days, expires_at, revoked_at)
			 values ($1, $2, $3, $4, 'read', 30,
			   now() + case when $5 = 'expired' then interval '-1 day' else interval '20 days' end,
			   case when $5 = 'revoked' then now() else null end)`,
			[
				user.id,
				keyName,
				randomBytes(32).toString("hex"),
				`portikus_${tag}${index}`,
				state,
			],
		);
		keys.push(keyName);
	}
	return { name, keys };
}

async function openKeysTab(page: Page) {
	await openAdmin(page);
	await page.goto("/admin/keys");
	await expect(page.getByRole("heading", { name: "API keys", level: 2 })).toBeVisible();
	await expect(page.getByTestId("api-keys-table")).toBeVisible({ timeout: 15_000 });
}

async function filterTo(page: Page, person: string) {
	await page.getByRole("combobox", { name: "Person" }).click();
	await page.getByRole("option", { name: person, exact: true }).click();
}

function rowFor(page: Page, keyName: string) {
	return page
		.getByTestId("api-keys-table")
		.getByRole("row")
		.filter({ hasText: keyName });
}

test("filtering by person shows only their keys, and one key expires behind a confirm", async ({
	page,
}) => {
	const ada = await instructorWithKeys(["active", "expired"]);
	const ben = await instructorWithKeys(["active"]);
	await openKeysTab(page);
	await expect(rowFor(page, ben.keys[0] ?? "")).toBeVisible();

	await filterTo(page, ada.name);
	const rows = page.getByTestId("api-keys-table").locator("tbody tr");
	await expect(rows).toHaveCount(2);
	await expect(rowFor(page, ben.keys[0] ?? "")).toHaveCount(0);

	const first = rowFor(page, ada.keys[0] ?? "");
	await first.getByRole("button", { name: "Expire…" }).click();
	const confirm = page.getByTestId("api-keys-confirm");
	await expect(confirm).toContainText("This affects 1 key");
	await expect(confirm).toContainText("can be renewed by its owner");
	await confirm.getByRole("button", { name: "Expire key" }).click();
	await expect(confirm).toBeHidden();
	await expect(first.getByText("Expired")).toBeVisible();
	// An expired key can still be revoked, but not expired again.
	await expect(first.getByRole("button", { name: "Expire…" })).toHaveCount(0);
	await expect(first.getByRole("button", { name: "Revoke…" })).toBeVisible();
	// Focus comes back to the key it acted on.
	await expect(first.getByText(ada.keys[0] ?? "", { exact: true })).toBeFocused();
});

test("revoking all of one person's keys counts them and leaves nothing to renew", async ({
	page,
}) => {
	const cara = await instructorWithKeys(["active", "expired", "revoked"]);
	await openKeysTab(page);
	await filterTo(page, cara.name);
	await page
		.getByRole("button", { name: `Revoke all of ${cara.name}'s keys…` })
		.click();
	const confirm = page.getByTestId("api-keys-confirm");
	await expect(confirm).toContainText(`Revoke all of ${cara.name}'s keys?`);
	// The revoked key is not counted again.
	await expect(confirm).toContainText("This affects 2 keys");
	await expect(confirm).toContainText("can never be renewed");
	await expect(confirm).toContainText("Expired keys, by contrast, can be renewed");
	await confirm.getByRole("button", { name: "Revoke 2 keys" }).click();
	await expect(confirm).toBeHidden();
	await expect(toast(page, "2 keys revoked")).toBeVisible();
	const rows = page.getByTestId("api-keys-table").locator("tbody tr");
	await expect(rows.getByRole("button")).toHaveCount(0);
	await expect(rows.filter({ hasText: "Revoked" })).toHaveCount(3);
});

test("revoke every key asks first and says how many keys it reaches", async ({
	page,
}) => {
	await instructorWithKeys(["active"]);
	// Revoking every key on the shared test site would break parallel tests, so
	// the request is answered here; the route itself is the API's to test.
	const posts: string[] = [];
	await routeApi(page, "**/admin/api-keys/revoke-all", async (route, request) => {
		posts.push(request.method());
		await route.fulfill({ json: { affected: 1 } });
	});
	await openKeysTab(page);
	await page.getByTestId("api-keys-revoke-all").click();
	const confirm = page.getByTestId("api-keys-confirm");
	await expect(confirm).toContainText("Revoke every API key on the site?");
	await expect(confirm).toContainText(/This affects \d+ keys?/);
	await expect(confirm).toContainText("cannot be undone");
	// Cancel sends nothing.
	await confirm.getByRole("button", { name: "Cancel" }).click();
	await expect(confirm).toBeHidden();
	expect(posts).toEqual([]);

	await page.getByTestId("api-keys-revoke-all").click();
	await confirm.getByRole("button", { name: /^Revoke \d+ keys?$/ }).click();
	await expect(confirm).toBeHidden();
	expect(posts).toEqual(["POST"]);
});

test("a row's buttons are described by the key's name and its owner", async ({
	page,
}) => {
	const dora = await instructorWithKeys(["active"]);
	await openKeysTab(page);
	await filterTo(page, dora.name);
	const row = rowFor(page, dora.keys[0] ?? "");
	for (const button of ["Expire…", "Revoke…"]) {
		const description = row.getByRole("button", { name: button });
		await expect(description).toHaveAccessibleDescription(
			new RegExp(`${dora.keys[0]}.*${dora.name}|${dora.name}.*${dora.keys[0]}`),
		);
	}
});

test("the tab's About line links to its administrator help topic", async ({
	page,
	context,
}) => {
	await openKeysTab(page);
	const intro = page.getByTestId("intro-admin-api-keys");
	await expect(intro).toContainText("use Portikus as their owner");
	await intro.getByText("About API keys", { exact: true }).click();
	const link = intro.getByRole("link", { name: /More in Help/ });
	await expect(link).toHaveAttribute("href", "/admin/help#admin-api-keys");
	const [help] = await Promise.all([context.waitForEvent("page"), link.click()]);
	await expect(help.getByRole("heading", { level: 3, name: "API keys" })).toBeFocused({
		timeout: 15_000,
	});
});

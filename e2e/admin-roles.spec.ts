import * as crypto from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
	createStudent,
	loginAs,
	MOCK_ISSUER,
	query,
	settledAxe,
	WEB_ORIGIN,
	workspacePath,
} from "./helpers";

/**
 * The Users view: search, roles, promote and demote (docs/EPIC-13-1.md
 * rulings 23 and 24). Carol is the mock provider's administrator. Every test
 * promotes its own fresh account rather than the shared mock `alice`, because
 * admin.spec.ts checks at the same time that alice has no Administration link.
 */

async function openUsers(page: Page): Promise<void> {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("admin-tab-workspaces")).toHaveText("Users");
}

async function insertUser(fields: {
	name: string;
	issuer?: string;
	username?: string;
	role?: "student" | "administrator";
	grantedRole?: "administrator" | null;
}): Promise<string> {
	const role = fields.role ?? "student";
	const [row] = await query<{ id: string }>(
		`insert into users
		   (oidc_issuer, oidc_subject, email, display_name, preferred_username,
		    role, provider_role, granted_role)
		 values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
		[
			fields.issuer ?? MOCK_ISSUER,
			`e2e-${crypto.randomUUID()}`,
			`${crypto.randomUUID().slice(0, 8)}@example.edu`,
			fields.name,
			fields.username ?? null,
			fields.grantedRole ? "administrator" : role,
			role,
			fields.grantedRole ?? null,
		],
	);
	if (!row) throw new Error("could not create the user");
	return row.id;
}

/** A signed-in student in a browser context of its own, with a readable name. */
async function signedInStudent(browser: Browser, name: string) {
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	const student = await createStudent(context);
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);
	return { context, ...student };
}

async function openDetail(page: Page, search: string, name: string) {
	await page.getByTestId("admin-filter-text").fill(search);
	await page.getByRole("button", { name: `Show details for ${name}` }).click();
	return page.getByRole("region", { name });
}

async function hasAdminLink(page: Page, path: string): Promise<number> {
	await page.goto(path);
	await page.getByTestId("me").click({ timeout: 15_000 });
	await expect(page.getByRole("menu")).toBeVisible();
	const count = await page.getByTestId("admin-link").count();
	await page.keyboard.press("Escape");
	return count;
}

test("search finds an account by name, username and source", async ({ page }) => {
	const tag = crypto.randomUUID().slice(0, 8);
	const sso = await insertUser({ name: `Find ${tag} Sso`, username: `u${tag}` });
	const course = await insertUser({
		name: `Find ${tag} Course`,
		issuer: "lti:https://lms-e2e.example.edu",
	});
	await openUsers(page);
	const rows = page.locator("[data-testid^=account-row-]");

	await page.getByTestId("admin-filter-text").fill(`Find ${tag}`);
	await expect(rows).toHaveCount(2);
	await page.getByTestId("admin-filter-text").fill(`u${tag}`);
	await expect(rows).toHaveCount(1);
	await expect(page.getByTestId(`account-row-${sso}`)).toBeVisible();
	await expect(page.getByTestId(`account-source-${sso}`)).toHaveText("SSO");

	await page.getByTestId("admin-filter-text").fill("lms-e2e.example.edu");
	await expect(page.getByTestId(`account-row-${course}`)).toBeVisible();
	await expect(page.getByTestId(`account-source-${course}`)).toHaveText(
		"Course: lms-e2e.example.edu",
	);

	await page.getByTestId("admin-filter-text").fill(`Find ${tag}`);
	await page.getByLabel("Role").selectOption("administrator");
	await expect(rows).toHaveCount(0);
});

test("promote gives the Administration link on the next page load, and demote takes it away", async ({
	page,
	browser,
}) => {
	const name = `Promo ${crypto.randomUUID().slice(0, 8)}`;
	const student = await signedInStudent(browser, name);
	const studentPage = await student.context.newPage();
	const path = workspacePath(student.workspaceId);
	try {
		expect(await hasAdminLink(studentPage, path)).toBe(0);

		await openUsers(page);
		const panel = await openDetail(page, name, name);
		await panel
			.getByRole("button", { name: `Promote ${name} to administrator` })
			.click();
		const promote = page.getByRole("alertdialog", {
			name: `Make ${name} an administrator?`,
		});
		await promote.getByRole("button", { name: "Promote" }).click();
		await expect(promote).toBeHidden();
		await expect(page.getByTestId(`account-role-${student.userId}`)).toHaveText(
			"Administrator (granted)",
		);
		expect(await hasAdminLink(studentPage, path)).toBe(1);

		await panel.getByRole("button", { name: `Demote ${name}` }).click();
		const demote = page.getByRole("alertdialog", { name: `Demote ${name}?` });
		await demote.getByRole("button", { name: "Demote" }).click();
		await expect(demote).toBeHidden();
		await expect(page.getByTestId(`account-role-${student.userId}`)).toHaveText(
			"Student",
		);
		expect(await hasAdminLink(studentPage, path)).toBe(0);
	} finally {
		await student.context.close();
	}
});

test("there is no demote for oneself or for an administrator from the provider", async ({
	page,
}) => {
	const name = `Provider ${crypto.randomUUID().slice(0, 8)}`;
	await insertUser({ name, role: "administrator" });
	await openUsers(page);

	const self = await openDetail(page, "carol@example.edu", "Carol Admin");
	const selfDemote = self.getByRole("button", { name: "Demote Carol Admin" });
	await expect(selfDemote).toHaveAttribute("aria-disabled", "true");
	await expect(self.getByText("You cannot demote your own account.")).toBeVisible();

	const provider = await openDetail(page, name, name);
	await expect(provider.getByTestId("detail-role")).toHaveText(
		"Administrator (from SSO)",
	);
	await expect(
		provider.getByRole("button", { name: `Demote ${name}` }),
	).toHaveAttribute("aria-disabled", "true");
	await expect(
		provider.getByText("This administrator comes from the SSO provider's groups."),
	).toBeVisible();
});

// The last-admin refusal: apps/api/src/routes/admin.test.ts, "two granted administrators demoting each other at once leave one administrator".

test("promote is refused for a course account, in the page and by the API", async ({
	page,
}) => {
	const name = `Course ${crypto.randomUUID().slice(0, 8)}`;
	const id = await insertUser({ name, issuer: "lti:https://lms-e2e.example.edu" });
	await openUsers(page);

	const panel = await openDetail(page, name, name);
	const promote = panel.getByRole("button", {
		name: `Promote ${name} to administrator`,
	});
	await expect(promote).toHaveAttribute("aria-disabled", "true");
	await expect(
		panel.getByText("Only SSO accounts can be administrators."),
	).toBeVisible();

	const response = await page.request.post(`/admin/users/${id}/promote`, {
		headers: { origin: WEB_ORIGIN },
	});
	expect(response.status()).toBe(400);
	expect((await response.json()).message).toBe(
		"Only SSO accounts can be administrators.",
	);
	const [row] = await query<{ granted_role: string | null }>(
		"select granted_role from users where id = $1",
		[id],
	);
	expect(row?.granted_role).toBeNull();
});

test("the Users tab and the role dialogs have no automatic accessibility violations", async ({
	page,
}) => {
	const name = `Axe ${crypto.randomUUID().slice(0, 8)}`;
	await insertUser({ name, grantedRole: "administrator" });
	const other = `Axe ${crypto.randomUUID().slice(0, 8)}`;
	await insertUser({ name: other });
	await openUsers(page);
	const axe = async () =>
		(await settledAxe(page)).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();

	expect((await axe()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

	const granted = await openDetail(page, name, name);
	await granted.getByRole("button", { name: `Demote ${name}` }).click();
	await expect(page.getByRole("alertdialog")).toBeVisible();
	expect((await axe()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	await page.getByRole("button", { name: "Cancel" }).click();

	const student = await openDetail(page, other, other);
	await student
		.getByRole("button", { name: `Promote ${other} to administrator` })
		.click();
	await expect(page.getByRole("alertdialog")).toBeVisible();
	expect((await axe()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

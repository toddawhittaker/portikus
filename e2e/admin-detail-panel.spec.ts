import * as crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import { createStudent, loginAs, MOCK_ISSUER, query } from "./helpers";

/**
 * The workspace detail panel's layout (docs/EPIC-18.md rulings 16 and 17,
 * issue #602, SPEC.md §20.1). Each test makes its own accounts, all named
 * with one tag, and filters the Users table down to them.
 */
test.use({ viewport: { width: 1920, height: 1080 } });

const SECTIONS = [
	"Account",
	"Workspace",
	"Storage",
	"Resource guard",
	"Ports and connections",
	"Logs",
	"Recent audit events",
];

test("the panel shows its actions at once, keeps its sections in order, and stays in view", async ({
	page,
	browser,
}) => {
	const tag = crypto.randomUUID().slice(0, 8);
	const context = await browser.newContext();
	const student = await createStudent(context);
	await context.close();
	const name = `Panel ${tag} Student`;
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);
	// Enough rows that the table is taller than the window.
	await query(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role, last_login_at)
		 select $1, 'e2e-' || $2 || '-' || n, 'panel-' || $2 || '-' || n || '@example.edu',
		        'Panel ' || $2 || ' ' || lpad(n::text, 2, '0'), 'student', now()
		 from generate_series(1, 40) as n`,
		[MOCK_ISSUER, tag],
	);

	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("admin-filter-text").fill(`Panel ${tag}`);
	await expect(page.locator("[data-testid^=account-row-]")).toHaveCount(41);

	await page.getByRole("button", { name: `Show details for ${name}` }).click();
	const panel = page.getByRole("region", { name });
	const heading = panel.getByRole("heading", { level: 3, name });
	await expect(heading).toBeFocused();
	await expect(panel.getByTestId("detail-quota")).toBeVisible({ timeout: 15_000 });

	// Start, Stop and Restart are in view without scrolling the panel.
	for (const action of ["Start", "Stop", "Restart"]) {
		await expect(
			panel.getByRole("button", { name: `${action} ${name}'s workspace`, exact: true }),
		).toBeInViewport();
	}

	for (const section of SECTIONS) {
		await expect(panel.getByRole("heading", { level: 4, name: section })).toHaveCount(
			1,
		);
	}
	const order = await panel
		.getByRole("heading", { level: 4 })
		.evaluateAll((elements) => elements.map((element) => element.textContent));
	expect(order).toEqual(SECTIONS);
	await expect(
		panel.getByRole("button", { name: `Edit quotas for ${name}'s workspace` }),
	).toBeVisible();

	// Tab runs from the heading through the head's actions, then into the sections.
	await page.keyboard.press("Tab");
	await expect(
		panel.getByRole("button", { name: `Start ${name}'s workspace`, exact: true }),
	).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(
		panel.getByRole("button", { name: `Stop ${name}'s workspace` }),
	).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(
		panel.getByRole("button", { name: `Restart ${name}'s workspace` }),
	).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(
		panel.getByRole("button", { name: `Close details for ${name}` }),
	).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(
		panel.getByRole("button", { name: `Disable account for ${name}` }),
	).toBeFocused();

	// Scroll the page to the bottom of the long table; the panel stays in view.
	const main = page.getByTestId("page-admin");
	await main.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await expect
		.poll(() => main.evaluate((element) => element.scrollTop))
		.toBeGreaterThan(200);
	await expect(heading).toBeInViewport();
	const box = await panel.boundingBox();
	expect(box?.y).toBeGreaterThanOrEqual(48);
	expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(1080);
});

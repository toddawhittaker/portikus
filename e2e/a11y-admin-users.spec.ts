/**
 * Automated accessibility checks (SPEC.md section 25.8) on the Users table
 * (SPEC.md section 20.1): tags, the Older image tag, the toolbar with a
 * selection, the detail panel beside the table at 1024 px, and the bulk
 * Enable confirmation, in the light and dark themes.
 */
import * as crypto from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { loginAs, MOCK_ISSUER, query, settledAxe, WCAG_TAGS } from "./helpers";

async function expectNoViolations(page: Page) {
	const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

async function insertUser(name: string, disabled: boolean): Promise<string> {
	const [row] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role, last_login_at, disabled_at)
		 values ($1, $2, $3, $4, 'student', now(), case when $5 then now() else null end)
		 returning id`,
		[
			MOCK_ISSUER,
			`e2e-${crypto.randomUUID()}`,
			`${crypto.randomUUID()}@example.edu`,
			name,
			disabled,
		],
	);
	if (!row) throw new Error("could not create the user");
	return row.id;
}

for (const scheme of ["light", "dark"] as const) {
	test(`the Users table, its toolbar and the Enable confirmation have no automatic violations (${scheme})`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 });
		await page.emulateMedia({ colorScheme: scheme });
		const tag = crypto.randomUUID().slice(0, 8);
		const active = await insertUser(`Axe ${tag} Active`, false);
		await insertUser(`Axe ${tag} Disabled`, true);
		const workspace = crypto.randomUUID();
		await query(
			`insert into workspaces (id, owner_user_id, label, incus_instance_name, state, desired_state)
			 values ($1, $2, $3, $4, 'running', 'running')`,
			[
				workspace,
				active,
				`ws-${workspace.slice(0, 8)}`,
				`ws-${workspace.replace(/-/g, "").slice(0, 24)}`,
			],
		);
		// Every tag the table can draw, on one row.
		await page.route("**/admin/users", async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			for (const user of body.users) {
				if (user.id !== active || !user.workspace) continue;
				const at = new Date().toISOString();
				user.markers = { ...user.markers, stale: true, linked: true };
				user.workspace.image = {
					label: "2026.09.1",
					fingerprint: "old",
					current: false,
				};
				user.workspace.activeConnections = 2;
				user.workspace.cpuThrottle = {
					at,
					thresholdPercent: 80,
					windowMinutes: 10,
					sharePercent: 25,
					held: { count: 3, hours: 24 },
					averagePercent: 97,
					allowance: "25ms/100ms",
				};
				user.workspace.memoryFlag = {
					at,
					averagePercent: 93,
					thresholdPercent: 90,
					windowMinutes: 10,
				};
			}
			await route.fulfill({ response, json: body });
		});

		await loginAs(page, "carol");
		await page.goto("/admin");
		await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("admin-filter-text").fill(`Axe ${tag}`);
		await expect(page.locator("[data-testid^=account-row-]")).toHaveCount(2);
		await expect(page.getByTestId(`account-image-${active}`)).toBeVisible();
		await expect(page.getByTestId("admin-row-count")).toHaveText(/^Showing 2 of \d+$/);
		await expectNoViolations(page);

		await page.getByRole("checkbox", { name: `Select Axe ${tag} Disabled` }).check();
		await page
			.getByRole("button", { name: `Show details for Axe ${tag} Active` })
			.click();
		await expect(page.getByRole("region", { name: `Axe ${tag} Active` })).toBeVisible();
		await expectNoViolations(page);

		await page.getByTestId("bulk-enable").click();
		const dialog = page.getByRole("alertdialog", { name: "Enable 1 account?" });
		await expect(dialog).toBeVisible();
		// Enabling takes nothing away, so the confirm is not drawn as danger (S3).
		const confirm = dialog.getByRole("button", { name: "Enable" });
		await expect(confirm).not.toHaveClass(/bg-status-danger/);
		await expectNoViolations(page);
	});
}

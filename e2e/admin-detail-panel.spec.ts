import * as crypto from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
	createStudent,
	loginAs,
	MOCK_ISSUER,
	query,
	settledAxe,
	toast,
	WCAG_TAGS,
} from "./helpers";

/**
 * The workspace detail panel's layout (SPEC.md section 20.1,
 * issue #602). Each test makes its own accounts, all named
 * with one tag, and filters the Users table down to them.
 */
test.use({ viewport: { width: 1920, height: 1080 } });

const SECTIONS = [
	"Workspace",
	"Resources",
	"Resource guard",
	"Processes",
	"Ports and connections",
	"Account",
	"Recent audit events",
];

async function expectNoViolations(page: Page) {
	const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** A student renamed with a tag, so the Users filter finds only them. */
async function namedStudent(
	browser: import("@playwright/test").Browser,
	prefix: string,
): Promise<{ userId: string; workspaceId: string; name: string }> {
	const context = await browser.newContext();
	const student = await createStudent(context);
	await context.close();
	const name = `${prefix} ${crypto.randomUUID().slice(0, 8)} Student`;
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);
	return { ...student, name };
}

async function openPanel(page: Page, name: string) {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("admin-filter-text").fill(name);
	await page.getByRole("button", { name: `Show details for ${name}` }).click();
	const panel = page.getByRole("region", { name });
	await expect(panel.getByTestId("detail-quota")).toBeVisible({ timeout: 15_000 });
	return panel;
}

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

	// A running workspace offers Stop and Restart, in view without scrolling the panel.
	for (const action of ["Stop", "Restart"]) {
		await expect(
			panel.getByRole("button", { name: `${action} ${name}'s workspace`, exact: true }),
		).toBeInViewport();
	}
	await expect(
		panel.getByRole("button", { name: `Start ${name}'s workspace`, exact: true }),
	).toHaveCount(0);

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
	// The Workspace section comes first; Rebuild stays focusable while it cannot act.
	await page.keyboard.press("Tab");
	await expect(
		panel.getByRole("button", { name: `Rebuild workspace for ${name}` }),
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

test.describe("at 1280 px", () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test("a full row fits beside the open panel", async ({ page, browser }) => {
		const tag = crypto.randomUUID().slice(0, 8);
		const context = await browser.newContext();
		const student = await createStudent(context);
		await context.close();
		const name = `Fit ${tag} Student`;
		const email = `a-rather-long-address-for-${tag}@students.example-university.edu`;
		await query("update users set display_name = $2, email = $3 where id = $1", [
			student.userId,
			name,
			email,
		]);
		// A second account with the same email puts a marker on the row.
		await query(
			`insert into users (oidc_issuer, oidc_subject, email, display_name, role, last_login_at)
			 values ($1, $2, $3, $4, 'student', now())`,
			[MOCK_ISSUER, `e2e-${tag}-dup`, email, `Fit ${tag} Twin`],
		);

		await loginAs(page, "carol");
		await page.goto("/admin");
		const table = page.getByTestId("admin-accounts");
		await expect(table).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("admin-filter-text").fill(`Fit ${tag}`);
		await expect(page.locator("[data-testid^=account-row-]")).toHaveCount(2);

		await page.getByRole("button", { name: `Show details for ${name}` }).click();
		const panel = page.getByRole("region", { name });
		await expect(panel.getByTestId("detail-quota")).toBeVisible({ timeout: 15_000 });
		const fit = await table.evaluate((t) => ({
			table: t.scrollWidth,
			wrap: (t.parentElement as HTMLElement).clientWidth,
		}));
		expect(fit.table).toBeLessThanOrEqual(fit.wrap);

		// Every section, the guard included, is a padded, divided section.
		const bare = await panel
			.getByRole("heading", { level: 4 })
			.evaluateAll(
				(headings) =>
					headings.filter((heading) => !heading.closest(".pk-detail-section")).length,
			);
		expect(bare).toBe(0);
	});
});

test.describe("at 1024 px", () => {
	test.use({ viewport: { width: 1024, height: 768 } });

	test("the panel keeps its content inside its 400 px, with long names and a throttle", async ({
		page,
		browser,
	}) => {
		const student = await namedStudent(browser, "Narrow");
		const long = `${student.name} Bartholomew-Featherstonehaugh-Cholmondeley`;
		await query("update users set display_name = $2 where id = $1", [
			student.userId,
			long,
		]);
		await query(
			`update workspaces set cpu_throttle = $2, limits_config = $3::jsonb where id = $1`,
			[
				student.workspaceId,
				JSON.stringify({
					at: new Date().toISOString(),
					averagePercent: 97,
					thresholdPercent: 80,
					windowMinutes: 30,
					sharePercent: 25,
					allowance: "25ms/100ms",
				}),
				JSON.stringify({ memoryMiB: 6144 }),
			],
		);
		const panel = await openPanel(page, long);
		await expect(panel.getByTestId("detail-lift-throttle")).toBeVisible();
		// The throttle says what it means, without the kernel's allowance (S7).
		await expect(panel.getByTestId("detail-guard-cpu")).not.toContainText("ms/");
		await expect(panel.getByTestId("detail-limits")).toContainText("6 GiB memory");
		const box = await panel.boundingBox();
		expect(Math.round(box?.width ?? 0)).toBe(400);
		// Nothing inside the panel is wider than the panel.
		const overflow = await panel.evaluate(
			(element) => element.scrollWidth - element.clientWidth,
		);
		expect(overflow).toBeLessThanOrEqual(0);
	});
});

test("while a workspace moves, its lifecycle buttons stay focusable, off, and say why", async ({
	page,
	browser,
}) => {
	const student = await namedStudent(browser, "Moving");
	await query("update workspaces set state = 'starting' where id = $1", [
		student.workspaceId,
	]);
	const panel = await openPanel(page, student.name);
	const stop = panel.getByRole("button", {
		name: `Stop ${student.name}'s workspace`,
		exact: true,
	});
	await expect(stop).toHaveAttribute("aria-disabled", "true");
	await expect(stop).toHaveAccessibleDescription(
		"Waiting for the workspace to finish starting.",
	);
	// Playwright will not click an aria-disabled button, so press it as a keyboard user would.
	await stop.focus();
	await page.keyboard.press("Enter");
	await expect(stop).toBeFocused();
	const [row] = await query<{ desired_state: string }>(
		"select desired_state from workspaces where id = $1",
		[student.workspaceId],
	);
	expect(row?.desired_state).toBe("running");

	// Once it settles as stopped, Start is the only lifecycle action.
	await query(
		"update workspaces set state = 'stopped', desired_state = 'stopped', updated_at = now() where id = $1",
		[student.workspaceId],
	);
	const start = panel.getByRole("button", {
		name: `Start ${student.name}'s workspace`,
		exact: true,
	});
	await expect(start).toBeVisible({ timeout: 15_000 });
	await expect(start).not.toHaveAttribute("aria-disabled");
	await expect(stop).toHaveCount(0);
});

test("the disconnect grace is edited in minutes and saved as seconds", async ({
	page,
	browser,
}) => {
	const student = await namedStudent(browser, "Grace");
	const panel = await openPanel(page, student.name);
	const grace = panel.getByTestId("detail-grace");
	await expect(grace).toContainText("(site setting)");

	const edit = panel.getByRole("button", {
		name: `Edit disconnect grace for ${student.name}`,
	});
	await edit.click();
	const dialog = page.getByRole("dialog", {
		name: `Disconnect grace for ${student.name}`,
	});
	const minutes = dialog.getByRole("textbox", { name: "Disconnect grace (minutes)" });
	await minutes.fill("soon");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Enter a number of minutes, 0 or more, or leave it blank.",
	);
	await minutes.fill("45");
	await minutes.press("Enter");
	await expect(toast(page, "Disconnect grace saved")).toBeVisible();
	await expect(dialog).toHaveCount(0);
	await expect(edit).toBeFocused();
	await expect(grace).toHaveText("45 minutes");
	await expect
		.poll(async () => {
			const [row] = await query<{ shutdown_grace_seconds: number | null }>(
				"select shutdown_grace_seconds from users where id = $1",
				[student.userId],
			);
			return row?.shutdown_grace_seconds ?? null;
		})
		.toBe(2700);

	// Blank goes back to the site setting.
	await edit.click();
	await expect(minutes).toHaveValue("45");
	await minutes.fill("");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(grace).toContainText("(site setting)");
});

test("promote and make instructor are confirmed without the danger colour; demote keeps it", async ({
	page,
	browser,
}) => {
	const student = await namedStudent(browser, "Confirm");
	const panel = await openPanel(page, student.name);
	await panel
		.getByRole("button", { name: `Promote ${student.name} to administrator` })
		.click();
	const promote = page.getByTestId("promote-dialog");
	await expect(promote.locator(".pk-dialog-status--neutral")).toHaveCount(1);
	await promote.getByRole("button", { name: "Cancel" }).click();

	await panel.getByRole("button", { name: `Make instructor: ${student.name}` }).click();
	const make = page.getByTestId("make-instructor-dialog");
	await expect(make.locator(".pk-dialog-status--neutral")).toHaveCount(1);
	await make.getByRole("button", { name: "Cancel" }).click();

	await panel
		.getByRole("button", { name: `Disable account for ${student.name}` })
		.click();
	const disable = page.getByTestId("disable-dialog");
	await expect(disable.locator(".pk-dialog-status--neutral")).toHaveCount(0);
	await disable.getByRole("button", { name: "Cancel" }).click();
});

for (const scheme of ["light", "dark"] as const) {
	test(`the panel and its grace and limits dialogs have no automatic violations (${scheme})`, async ({
		page,
		browser,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const student = await namedStudent(browser, `A11y panel ${scheme}`);
		await query(
			"update workspaces set state = 'stopping', desired_state = 'stopped' where id = $1",
			[student.workspaceId],
		);
		const panel = await openPanel(page, student.name);
		await expect(panel.getByTestId("detail-lifecycle-note")).toBeVisible();
		await expectNoViolations(page);

		await panel.getByTestId("detail-grace-edit").click();
		const grace = page.getByTestId("grace-dialog");
		await grace.getByRole("textbox").fill("x");
		await grace.getByRole("button", { name: "Save" }).click();
		await expect(grace.getByRole("alert")).toBeVisible();
		await expectNoViolations(page);
		await grace.getByRole("button", { name: "Cancel" }).click();

		await panel.getByTestId("detail-limits-edit").click();
		await expect(page.getByTestId("limits-dialog")).toBeVisible();
		await expectNoViolations(page);
	});
}

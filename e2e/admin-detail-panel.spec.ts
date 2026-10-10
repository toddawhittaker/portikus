import * as crypto from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { backupSet, hostStatus } from "./backup-channel";
import {
	createStudent,
	expectNoViolations,
	finishOperation,
	loginAs,
	MOCK_ISSUER,
	openToggletip,
	query,
	recordToasts,
	routeApi,
	toast,
} from "./helpers";

/**
 * The workspace detail panel's layout (SPEC.md section 20.1). Each test
 * makes its own accounts, all named
 * with one tag, and filters the Users table down to them.
 */
test.use({ viewport: { width: 1920, height: 1080 } });

const SECTIONS = [
	"Workspace",
	"Resources",
	"Resource guard",
	"Processes",
	"Ports and connections",
	"Agent log, reported by the workspace",
	"Account",
	"Recent audit events",
];

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
		await expect(
			panel.getByRole("heading", { level: 4, name: section, exact: true }),
		).toHaveCount(1);
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
	// The Workspace section comes first, starting with Restore from backup.
	await page.keyboard.press("Tab");
	await expect(
		panel.getByRole("button", { name: `Restore from backup: ${name}'s workspace` }),
	).toBeFocused();
	// Rebuild stays focusable while it cannot act, with its toggletip after it.
	await page.keyboard.press("Tab");
	await expect(
		panel.getByRole("button", { name: `Rebuild workspace for ${name}` }),
	).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(
		panel.getByRole("button", { name: "About Rebuild workspace" }),
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
		// The throttle says what it means, without the kernel's allowance.
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

test("a workspace stuck starting keeps Stop and Restart on, so an admin can rescue it", async ({
	page,
	browser,
}) => {
	const student = await namedStudent(browser, "Stuck");
	// Wanted running, still stopped: a start the worker has not finished.
	await query(
		"update workspaces set state = 'stopped', desired_state = 'running' where id = $1",
		[student.workspaceId],
	);
	const panel = await openPanel(page, student.name);
	await expect(panel.getByTestId("detail-lifecycle-note")).toHaveText(
		"Waiting for the workspace to finish starting.",
	);
	const stop = panel.getByRole("button", {
		name: `Stop ${student.name}'s workspace`,
		exact: true,
	});
	await expect(stop).not.toHaveAttribute("aria-disabled");
	await expect(
		panel.getByRole("button", {
			name: `Restart ${student.name}'s workspace`,
			exact: true,
		}),
	).not.toHaveAttribute("aria-disabled");
	const response = page.waitForResponse(
		(r) =>
			r.url().endsWith(`/workspaces/${student.workspaceId}/stop`) &&
			r.request().method() === "POST",
	);
	await stop.click();
	expect((await response).ok()).toBe(true);
	const [row] = await query<{ desired_state: string }>(
		"select desired_state from workspaces where id = $1",
		[student.workspaceId],
	);
	expect(row?.desired_state).toBe("stopped");

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

test("Restore from backup restores this workspace from a set that holds it", async ({
	page,
	browser,
}) => {
	const student = await namedStudent(browser, "Restore");
	const [row] = await query<{ incus_instance_name: string }>(
		"select incus_instance_name from workspaces where id = $1",
		[student.workspaceId],
	);
	const instance = row?.incus_instance_name ?? "";
	const stamp = "20260924T023000Z";
	// The backup host is played by stubbing its report, so this spec never
	// touches the shared backup channel the Backups tab's serial tests use.
	await routeApi(page, "**/admin/backups", async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		const response = await route.fetch();
		const body = await response.json();
		body.host = hostStatus({ sets: [backupSet(stamp, [instance])] });
		body.hostReportedAt = new Date().toISOString();
		body.hostStale = false;
		// The API lists only the workspaces a reported set holds.
		body.workspaces = [
			{
				id: student.workspaceId,
				instance,
				label: "restore-e2e",
				ownerName: student.name,
				state: "running",
			},
		];
		await route.fulfill({ response, json: body });
	});
	let sent: unknown = null;
	await page.route("**/admin/backups/restores", async (route) => {
		sent = route.request().postDataJSON();
		await route.fulfill({
			status: 202,
			json: {
				id: crypto.randomUUID(),
				kind: "restore_copy",
				args: { stamp, instance, dir: "restored-2026-09-24-0230" },
				state: "pending",
				requestedAt: new Date().toISOString(),
				claimedAt: null,
				finishedAt: null,
				error: null,
				workspaceId: student.workspaceId,
				result: null,
			},
		});
	});

	const panel = await openPanel(page, student.name);
	const open = panel.getByRole("button", {
		name: `Restore from backup: ${student.name}'s workspace`,
	});
	await open.click();
	const dialog = page.getByRole("dialog", { name: "Restore from backup" });
	await expect(dialog.getByTestId("backup-restore-folder")).toHaveText(
		"~/restored-2026-09-24-0230",
	);
	await dialog.getByTestId("backup-restore-confirm").click();
	await expect(toast(page, "Restore requested")).toBeVisible();
	await expect(dialog).toHaveCount(0);
	expect(sent).toEqual({ stamp, workspaceId: student.workspaceId });
	await expect(open).toBeFocused();
	// A panel refresh can still be in the backups route when the test ends.
	await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a toggletip opens from the keyboard, explains, and gives focus back on Escape", async ({
	page,
	browser,
}) => {
	const student = await namedStudent(browser, "Tips");
	const panel = await openPanel(page, student.name);
	const about = panel.getByRole("button", { name: "About Last input" });
	await about.focus();
	await page.keyboard.press("Enter");
	const tip = openToggletip(page);
	await expect(tip).toContainText("Idle stop counts from here.");
	await page.keyboard.press("Escape");
	await expect(tip).toHaveCount(0);
	await expect(about).toBeFocused();
});

for (const scheme of ["light", "dark"] as const) {
	test(`an open toggletip in the panel has no automatic violations (${scheme})`, async ({
		page,
		browser,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const student = await namedStudent(browser, `A11y tip ${scheme}`);
		const panel = await openPanel(page, student.name);
		await panel.getByRole("button", { name: "About Rebuild workspace" }).click();
		await expect(openToggletip(page)).toBeVisible();
		await expectNoViolations(page);
	});
}

// The Users view watches operations, so the end is announced with the panel gone.
for (const { how, endAction, ok, message } of [
	{
		how: "closed",
		endAction: "workspace.rebuilt",
		ok: true,
		message: "Rebuild of {name}'s workspace finished",
	},
	{
		how: "switched to another account",
		endAction: "workspace.docker_reset_failed",
		ok: false,
		message: "Docker reset of {name}'s workspace failed",
	},
]) {
	test(`an operation that ends after its panel is ${how} is still announced, once`, async ({
		page,
		browser,
	}) => {
		const tag = crypto.randomUUID().slice(0, 8);
		const student = await namedStudent(browser, `Ends ${tag}`);
		const other = await namedStudent(browser, `Ends ${tag}`);
		await query("update workspaces set pending_operation = $2 where id = $1", [
			student.workspaceId,
			ok ? "rebuild" : "reset-docker",
		]);
		const panel = await openPanel(page, student.name);
		await expect(panel.getByTestId("pending-operation")).toBeVisible();
		const row = page.getByTestId(`account-row-${student.userId}`);
		const badge = row.getByText(ok ? "Rebuilding…" : "Resetting Docker…");
		await expect(badge).toBeVisible();
		await expect(row.locator(".pk-spin")).toHaveCount(1);

		if (how === "closed") {
			await panel
				.getByRole("button", { name: `Close details for ${student.name}` })
				.click();
		} else {
			await page.getByTestId("admin-filter-text").fill(`Ends ${tag}`);
			await page
				.getByRole("button", { name: `Show details for ${other.name}` })
				.click();
			await expect(page.getByRole("region", { name: other.name })).toBeVisible();
		}
		await expect(panel).toHaveCount(0);
		const shownToasts = await recordToasts(page);

		await finishOperation(student.workspaceId, endAction, ok);
		const title = message.replace("{name}", student.name);
		const end = toast(page, title);
		await expect(end).toBeVisible({ timeout: 15_000 });
		await expect(end.getByRole(ok ? "status" : "alert")).toHaveCount(1);
		await expect(badge).toHaveCount(0, { timeout: 15_000 });
		// A later poll brings no second toast.
		await page.waitForTimeout(6000);
		expect((await shownToasts()).filter((text) => text.includes(title))).toHaveLength(
			1,
		);
	});
}

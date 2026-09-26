import * as crypto from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
	createStudent,
	loginAs,
	MOCK_ISSUER,
	query,
	type TestStudent,
	toast,
	workspacePath,
} from "./helpers";

/**
 * The admin Workspaces tab and its detail panel (SPEC.md §20.1, issue #302;
 * docs/archive/epics/EPIC-11.md task 5). Carol is the mock provider's administrator. Every
 * test makes its own accounts straight in the database, filters the table
 * down to them, and never touches another test's rows.
 */

async function openAdmin(page: Page): Promise<void> {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
}

async function filterTo(page: Page, text: string): Promise<void> {
	await page.getByTestId("admin-filter-text").fill(text);
}

/** A student with a workspace, made in a context of its own so carol keeps her session. */
async function studentIn(browser: Browser): Promise<TestStudent & { name: string }> {
	const context = await browser.newContext();
	const student = await createStudent(context);
	await context.close();
	const name = `E2E ${student.userId.slice(0, 8)}`;
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);
	return { ...student, name };
}

async function openDetail(page: Page, name: string) {
	await filterTo(page, name);
	await page.getByRole("button", { name: `Show details for ${name}` }).click();
	const panel = page.getByRole("region", { name });
	await expect(panel.getByTestId("detail-quota")).toBeVisible();
	return panel;
}

async function insertUser(
	email: string,
	name: string,
	lastLoginDaysAgo: number,
): Promise<string> {
	const [row] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role, last_login_at)
		 values ($1, $2, $3, $4, 'student', now() - make_interval(days => $5))
		 returning id`,
		[MOCK_ISSUER, `e2e-${crypto.randomUUID()}`, email, name, lastLoginDaysAgo],
	);
	if (!row) throw new Error("could not create the user");
	return row.id;
}

test("two accounts that share an email are both marked and sit together", async ({
	page,
}) => {
	const tag = crypto.randomUUID().slice(0, 8);
	const email = `dup-${tag}@example.edu`;
	const first = await insertUser(email, `Dup ${tag} Newer`, 0);
	await insertUser(`other-${tag}@example.edu`, `Dup ${tag} Middle`, 0);
	const second = await insertUser(email.toUpperCase(), `Dup ${tag} Older`, 2);

	await openAdmin(page);
	await filterTo(page, `Dup ${tag}`);

	const rows = page.locator("[data-testid^=account-row-]");
	await expect(rows).toHaveCount(3);
	const ids = await rows.evaluateAll((elements) =>
		elements.map((element) => element.getAttribute("data-testid")),
	);
	const at = [
		ids.indexOf(`account-row-${first}`),
		ids.indexOf(`account-row-${second}`),
	];
	expect(Math.abs((at[0] ?? 0) - (at[1] ?? 9))).toBe(1);
	for (const id of [first, second]) {
		await expect(
			page
				.getByTestId(`account-row-${id}`)
				.getByText("Duplicate email", { exact: true }),
		).toBeVisible();
	}
	// The older of the two is stale because the newer one signed in since.
	await expect(
		page.getByTestId(`account-row-${second}`).getByText("Stale", { exact: true }),
	).toBeVisible();
});

test("an account with no sign-in for 31 days is marked Stale", async ({ page }) => {
	const tag = crypto.randomUUID().slice(0, 8);
	const id = await insertUser(`stale-${tag}@example.edu`, `Stale ${tag}`, 31);

	await openAdmin(page);
	await filterTo(page, `Stale ${tag}`);

	const row = page.getByTestId(`account-row-${id}`);
	await expect(row.getByText("Stale", { exact: true })).toBeVisible();
	// Last sign-in left the table (SPEC.md section 20.1) and shows in the detail panel.
	await page.getByRole("button", { name: `Show details for Stale ${tag}` }).click();
	const panel = page.getByRole("region", { name: `Stale ${tag}` });
	await expect(panel.getByTestId("detail-last-sign-in")).toHaveText("31 days ago");
});

test("an administrator stops another user's workspace, and it is audited", async ({
	page,
	browser,
}) => {
	const student = await studentIn(browser);
	await openAdmin(page);
	const panel = await openDetail(page, student.name);

	await panel.getByRole("button", { name: `Stop ${student.name}'s workspace` }).click();
	await expect(toast(page, `Asked to stop ${student.name}'s workspace`)).toBeVisible();

	await expect
		.poll(async () => {
			const [row] = await query<{ desired_state: string }>(
				"select desired_state from workspaces where id = $1",
				[student.workspaceId],
			);
			return row?.desired_state;
		})
		.toBe("stopped");
	const [carol] = await query<{ id: string }>(
		"select id from users where display_name = 'Carol Admin'",
	);
	const audit = await query<{ actor: string }>(
		"select actor from audit_events where target = $1 and action = 'workspace.stop_requested'",
		[student.workspaceId],
	);
	expect(audit.map((row) => row.actor)).toContain(`user:${carol?.id}`);

	// The panel shows the stop as motion, then lists the audit row.
	await expect(panel.getByTestId("detail-state")).toContainText("Stopping");
	await expect(panel.getByText("workspace.stop_requested")).toBeVisible({
		timeout: 10_000,
	});
	await panel.getByTestId("detail-all-events").click();
	await expect(page).toHaveURL(
		new RegExp(`/admin\\?tab=audit&workspace=${student.workspaceId}$`),
	);
});

test("disabling an account signs the student out, and enabling lets them back", async ({
	page,
	browser,
}) => {
	const context = await browser.newContext();
	const student = await createStudent(context);
	const name = `E2E ${student.userId.slice(0, 8)}`;
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);
	const studentPage = await context.newPage();
	await studentPage.goto(workspacePath(student.workspaceId));
	await expect(studentPage.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });

	await openAdmin(page);
	const panel = await openDetail(page, name);
	await panel.getByRole("button", { name: `Disable account for ${name}` }).click();
	await page.getByTestId("disable-dialog").getByTestId("dialog-confirm").click();
	await expect(toast(page, `${name} disabled`)).toBeVisible();
	await expect(
		page
			.getByTestId(`account-row-${student.userId}`)
			.getByText("Disabled", { exact: true }),
	).toBeVisible();

	// The student's session is gone: the next load is signed out.
	await studentPage.reload();
	await expect(
		studentPage
			.getByTestId("signin")
			.or(studentPage.getByTestId("page-session-ended"))
			.first(),
	).toBeVisible({ timeout: 15_000 });
	await context.close();

	await panel.getByRole("button", { name: `Enable account for ${name}` }).click();
	await expect(toast(page, `${name} enabled`)).toBeVisible();
	await expect
		.poll(async () => {
			const [row] = await query<{ disabled_at: Date | null }>(
				"select disabled_at from users where id = $1",
				[student.userId],
			);
			return row?.disabled_at ?? null;
		})
		.toBeNull();
});

test("archive hides the row, refuses a start, and unarchive brings it back", async ({
	page,
	browser,
}) => {
	const student = await studentIn(browser);
	await openAdmin(page);
	const panel = await openDetail(page, student.name);
	// Opening the panel moves focus to its heading (Gate E).
	await expect(panel.getByRole("heading", { name: student.name })).toBeFocused();

	const archive = panel.getByRole("button", {
		name: `Archive workspace for ${student.name}`,
	});
	// Cancelling puts focus back on the button that opened the dialog.
	await archive.click();
	await page
		.getByTestId("archive-dialog")
		.getByRole("button", { name: "Cancel" })
		.click();
	await expect(archive).toBeFocused();

	await archive.click();
	await page.getByTestId("archive-dialog").getByTestId("dialog-confirm").click();
	await expect(toast(page, "Workspace archived")).toBeVisible();

	const row = page.getByTestId(`account-row-${student.userId}`);
	await expect(row).toHaveCount(0);
	await expect(page.getByTestId("admin-row-count")).toContainText("Showing 0 of");
	await page.getByText("Show archived").click();
	await expect(row.getByText("Archived", { exact: true })).toBeVisible();

	await panel
		.getByRole("button", { name: `Start ${student.name}'s workspace`, exact: true })
		.click();
	await expect(
		toast(page, "This workspace was archived by an administrator."),
	).toBeVisible();

	const unarchive = panel.getByRole("button", {
		name: `Unarchive workspace for ${student.name}`,
	});
	await unarchive.click();
	await expect(toast(page, "Workspace unarchived")).toBeVisible();
	// The button swaps to Archive in place; focus stays on it (Gate E).
	await expect(archive).toBeFocused();
	await page.getByText("Show archived").click();
	await expect(row).toBeVisible();
	await expect(row.getByText("Archived", { exact: true })).toHaveCount(0);
});

test("storage can only grow, and a grow shows as pending", async ({
	page,
	browser,
}) => {
	const student = await studentIn(browser);
	// The worker has applied what was asked for, so nothing is pending yet.
	const before = { home: 10, docker: 10 };
	await query(
		`update workspaces set quota_config = $2::jsonb, quota_applied = $2::jsonb where id = $1`,
		[
			student.workspaceId,
			JSON.stringify({ homeGiB: before.home, dockerGiB: before.docker }),
		],
	);

	await openAdmin(page);
	const panel = await openDetail(page, student.name);
	await expect(panel.getByTestId("detail-quota-pending")).toHaveCount(0);

	await panel
		.getByRole("button", { name: `Edit quotas for ${student.name}'s workspace` })
		.click();
	const dialog = page.getByTestId("quota-dialog");
	await dialog.getByTestId("quota-home").fill(String(before.home - 1));
	await dialog.getByTestId("quota-save").click();
	await expect(dialog.getByRole("alert")).toHaveText("Storage can only be increased.");

	await dialog.getByTestId("quota-home").fill(String(before.home + 5));
	await dialog.getByTestId("quota-save").click();
	await expect(toast(page, "Storage change requested")).toBeVisible();
	await expect(dialog).toHaveCount(0);

	await expect(panel.getByTestId("detail-quota")).toHaveText(
		`Home ${before.home + 5} GiB · Docker ${before.docker} GiB`,
	);
	await expect(panel.getByTestId("detail-quota-pending")).toBeVisible();
});

async function workspaceLabel(workspaceId: string): Promise<string> {
	const [row] = await query<{ label: string }>(
		"select label from workspaces where id = $1",
		[workspaceId],
	);
	if (!row) throw new Error("no workspace");
	return row.label;
}

async function pendingOperation(workspaceId: string): Promise<string | null> {
	const [row] = await query<{ pending_operation: string | null }>(
		"select pending_operation from workspaces where id = $1",
		[workspaceId],
	);
	return row?.pending_operation ?? null;
}

// The worker does not run here, so a requested operation stays pending.
for (const { name, button, dialogId, confirmLabel, done, operation, action } of [
	{
		name: "Rebuild",
		button: (student: string) => `Rebuild workspace for ${student}`,
		dialogId: "rebuild-dialog",
		confirmLabel: "Rebuild",
		done: "Rebuild requested",
		operation: "rebuild",
		action: "workspace.rebuild_requested",
	},
	{
		name: "Reset Docker",
		button: (student: string) => `Reset Docker for ${student}`,
		dialogId: "reset-docker-dialog",
		confirmLabel: "Reset Docker",
		done: "Docker reset requested",
		operation: "reset-docker",
		action: "workspace.docker_reset_requested",
	},
]) {
	test(`${name} from the admin detail asks for the label, then shows it pending and audited`, async ({
		page,
		browser,
	}) => {
		const student = await studentIn(browser);
		const label = await workspaceLabel(student.workspaceId);
		await openAdmin(page);
		const panel = await openDetail(page, student.name);
		await expect(panel.getByTestId("capability-note")).toHaveCount(0);

		await panel.getByRole("button", { name: button(student.name) }).click();
		const dialog = page.getByTestId(dialogId);
		const confirm = dialog.getByTestId("dialog-confirm");
		await expect(confirm).toHaveText(confirmLabel);
		await expect(confirm).toBeDisabled();
		await dialog.getByRole("textbox").fill(label.toUpperCase());
		await expect(confirm).toBeDisabled();
		await dialog.getByRole("textbox").fill(label);
		await confirm.click();
		await expect(toast(page, done)).toBeVisible();

		await expect.poll(() => pendingOperation(student.workspaceId)).toBe(operation);
		await expect(panel.getByTestId("pending-operation")).toBeVisible();
		await expect(
			panel.getByRole("button", { name: `Rebuild workspace for ${student.name}` }),
		).toBeDisabled();
		await expect(
			panel.getByRole("button", {
				name: `Reset Docker for ${student.name}`,
			}),
		).toBeDisabled();
		await expect(panel.getByText(action)).toBeVisible();
	});
}

/** The Users table of SPEC.md section 20.1. */
test.describe("the Users table layout", () => {
	test.use({ viewport: { width: 1280, height: 600 } });

	test("seven columns, a sticky header, centred filter extras, no sideways scroll", async ({
		page,
	}) => {
		const tag = crypto.randomUUID().slice(0, 8);
		const ids: string[] = [];
		for (let n = 0; n < 25; n++) {
			ids.push(
				await insertUser(`layout-${tag}-${n}@example.edu`, `Layout ${tag} ${n}`, 0),
			);
		}
		await openAdmin(page);
		await filterTo(page, `Layout ${tag}`);
		await expect(page.locator("[data-testid^=account-row-]")).toHaveCount(25);

		const table = page.getByTestId("admin-accounts");
		await expect(table.locator("thead th")).toHaveText([
			"Select all shown accounts",
			"Account",
			"Role",
			"Workspace",
			"Last activity",
			"Image",
			"Connections",
		]);

		// The checkbox and the count sit on the middle of the select controls.
		const middle = async (box: { y: number; height: number } | null) =>
			box ? box.y + box.height / 2 : Number.NaN;
		const control = await middle(
			await page.getByTestId("admin-filter-role").boundingBox(),
		);
		const archived = await middle(
			// The input is a 1 px hidden box; the drawn label is what the eye sees.
			await page.locator("label.pk-check", { hasText: "Show archived" }).boundingBox(),
		);
		const count = await middle(await page.getByTestId("admin-row-count").boundingBox());
		expect(Math.abs(archived - control)).toBeLessThanOrEqual(1);
		expect(Math.abs(count - control)).toBeLessThanOrEqual(1);

		// The header stays in view after <main> scrolls.
		const header = table.getByRole("columnheader", { name: "Account", exact: true });
		await page.locator("main").evaluate((main) => {
			main.scrollTop = main.scrollHeight;
		});
		const mainTop = await page
			.locator("main")
			.evaluate((m) => m.getBoundingClientRect().top);
		// The list is long enough that <main> really scrolled.
		expect(await page.locator("main").evaluate((m) => m.scrollTop)).toBeGreaterThan(
			200,
		);
		const headerBox = await header.boundingBox();
		// At <main>'s top edge, so no row shows through <main>'s padding above it.
		expect(Math.abs((headerBox?.y ?? -99) - mainTop)).toBeLessThanOrEqual(1);

		// With the detail panel open at 1280 px the table does not scroll sideways.
		await page
			.getByRole("button", { name: `Show details for Layout ${tag} 0,` })
			.click();
		await expect(page.getByRole("region", { name: `Layout ${tag} 0` })).toBeVisible();
		const overflow = await table.evaluate((t) => {
			const wrap = t.parentElement as HTMLElement;
			return {
				table: t.scrollWidth,
				wrap: wrap.clientWidth,
				page: document.documentElement.scrollWidth,
				view: window.innerWidth,
			};
		});
		expect(overflow.table).toBeLessThanOrEqual(overflow.wrap);
		expect(overflow.page).toBeLessThanOrEqual(overflow.view);
	});
});

import * as crypto from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
	createStudent,
	MOCK_ISSUER,
	openAdmin,
	openToggletip,
	query,
	routeApi,
	settledAxe,
	studentIn,
	toast,
	WCAG_TAGS,
	workspacePath,
} from "./helpers";

/**
 * The admin Workspaces tab and its detail panel (SPEC.md §20.1). Carol is
 * the mock provider's administrator. Every
 * test makes its own accounts straight in the database, filters the table
 * down to them, and never touches another test's rows.
 */

async function filterTo(page: Page, text: string): Promise<void> {
	await page.getByTestId("admin-filter-text").fill(text);
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

test("a just-created account is not Stale and says Not signed in yet", async ({
	page,
}) => {
	const tag = crypto.randomUUID().slice(0, 8);
	const [row] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role)
		 values ($1, $2, $3, $4, 'student') returning id`,
		[MOCK_ISSUER, `e2e-${crypto.randomUUID()}`, `new-${tag}@example.edu`, `New ${tag}`],
	);
	if (!row) throw new Error("could not create the user");

	await openAdmin(page);
	await filterTo(page, `New ${tag}`);

	const account = page.getByTestId(`account-row-${row.id}`);
	await expect(account.getByText("Not signed in yet", { exact: true })).toBeVisible();
	await expect(account.getByText("Stale", { exact: true })).toHaveCount(0);
});

test("an administrator stops another user's workspace, and it is audited", async ({
	page,
	browser,
}) => {
	const student = await studentIn(browser, "E2E");
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
		new RegExp(`/admin/audit\\?workspace=${student.workspaceId}$`),
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
	const student = await studentIn(browser, "E2E");
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

	// No worker runs here, so settle the stop the archive asked for.
	await query(
		"update workspaces set state = 'stopped', updated_at = now() where id = $1",
		[student.workspaceId],
	);
	// Start stays in reach but refuses, and says why (SPEC.md §25.8).
	const start = panel.getByRole("button", {
		name: `Start ${student.name}'s workspace`,
		exact: true,
	});
	// The panel refetches on its own timer, so the settled state can take a moment.
	await expect(start).toHaveAccessibleDescription(
		"An archived workspace cannot start. Unarchive it first.",
		{ timeout: 15_000 },
	);
	await expect(start).toHaveAttribute("aria-disabled", "true");
	await start.focus();
	await page.keyboard.press("Enter");
	const [desired] = await query<{ desired_state: string }>(
		"select desired_state from workspaces where id = $1",
		[student.workspaceId],
	);
	expect(desired?.desired_state).toBe("stopped");

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
	const student = await studentIn(browser, "E2E");
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
		const student = await studentIn(browser, "E2E");
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

test("a workspace on an old image says Old image, not Stale, and loses it when its rebuild finishes", async ({
	page,
	browser,
}) => {
	const student = await studentIn(browser, "E2E");
	const label = await workspaceLabel(student.workspaceId);
	// Image currency comes from the worker's host sample, which e2e has none of,
	// so the list answer says the image is old until the fake rebuild finishes.
	let rebuilt = false;
	await routeApi(page, "**/admin/users", async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		for (const user of body.users) {
			if (user.id !== student.userId || !user.workspace) continue;
			user.workspace.image = {
				label: rebuilt ? "2026.09.13" : "2026.09.12",
				fingerprint: rebuilt ? "new" : "old",
				current: rebuilt,
			};
		}
		await route.fulfill({ response, json: body });
	});
	await openAdmin(page);
	const panel = await openDetail(page, student.name);
	const row = page.getByTestId(`account-row-${student.userId}`);
	await expect(page.getByTestId(`account-image-${student.userId}`)).toHaveText(
		"Old image",
	);
	// A student who signed in today is not stale, whatever image the workspace runs.
	await expect(row).not.toHaveAttribute("data-markers", /Stale/);

	await panel
		.getByRole("button", { name: `Rebuild workspace for ${student.name}` })
		.click();
	const dialog = page.getByTestId("rebuild-dialog");
	await dialog.getByRole("textbox").fill(label);
	await dialog.getByTestId("dialog-confirm").click();
	await expect(panel.getByTestId("pending-operation")).toBeVisible();

	// Play the worker: the rebuild finishes and the workspace is on the default image.
	rebuilt = true;
	await query(
		"update workspaces set pending_operation = null, pending_operation_at = null, pending_operation_by = null where id = $1",
		[student.workspaceId],
	);
	await expect(panel.getByTestId("pending-operation")).toHaveCount(0, {
		timeout: 15_000,
	});
	await expect(page.getByTestId(`account-image-${student.userId}`)).toHaveCount(0, {
		timeout: 15_000,
	});
});

/** Play the worker's end of an operation: clear it, then audit the result (ADR 0021). */
async function finishOperation(
	workspaceId: string,
	action: string,
	ok: boolean,
): Promise<void> {
	await query(
		`update workspaces set pending_operation = null, pending_operation_at = null,
		 pending_operation_by = null, state = $2, error_code = $3 where id = $1`,
		[workspaceId, ok ? "stopped" : "error", ok ? null : "CONTROLLER_TIMEOUT"],
	);
	await query(
		`insert into audit_events (actor, target, action, result, metadata)
		 values ('worker', $1, $2, $3, $4)`,
		[
			workspaceId,
			action,
			ok ? "ok" : "failed",
			JSON.stringify(ok ? {} : { errorCode: "CONTROLLER_TIMEOUT" }),
		],
	);
}

// The panel and the row say what is running, then how it ended.
for (const { name, button, dialogId, running, endAction, ok, message, role } of [
	{
		name: "a rebuild that succeeds",
		button: (student: string) => `Rebuild workspace for ${student}`,
		dialogId: "rebuild-dialog",
		running: "Rebuilding…",
		endAction: "workspace.rebuilt",
		ok: true,
		message: "Rebuild of {name}'s workspace finished",
		role: "status",
	},
	{
		name: "a Docker reset that fails",
		button: (student: string) => `Reset Docker for ${student}`,
		dialogId: "reset-docker-dialog",
		running: "Resetting Docker…",
		endAction: "workspace.docker_reset_failed",
		ok: false,
		message: "Docker reset of {name}'s workspace failed",
		role: "alert",
	},
]) {
	test(`${name} shows its progress on the panel and row, then announces the result`, async ({
		page,
		browser,
	}) => {
		const student = await studentIn(browser, "E2E");
		const label = await workspaceLabel(student.workspaceId);
		await openAdmin(page);
		const panel = await openDetail(page, student.name);
		const state = panel.getByTestId("detail-state");
		const row = page.getByTestId(`account-row-${student.userId}`);

		await panel.getByRole("button", { name: button(student.name) }).click();
		const dialog = page.getByTestId(dialogId);
		await dialog.getByRole("textbox").fill(label);
		await dialog.getByTestId("dialog-confirm").click();

		// Straight away, without waiting for a poll: the confirm refetches.
		await expect(state).toHaveText(running, { timeout: 3000 });
		await expect(state).toHaveAttribute("role", "status");
		await expect(state.locator(".pk-spin")).toHaveCount(1);
		await expect(row.getByText(running)).toBeVisible({ timeout: 3000 });
		await expect(
			panel.getByRole("button", { name: `Rebuild workspace for ${student.name}` }),
		).toBeDisabled();
		await expect(
			panel.getByRole("button", { name: `Reset Docker for ${student.name}` }),
		).toBeDisabled();

		await finishOperation(student.workspaceId, endAction, ok);
		const end = toast(page, message.replace("{name}", student.name));
		await expect(end).toBeVisible({ timeout: 15_000 });
		await expect(end.getByRole(role)).toHaveCount(1);
		await expect(state).not.toHaveText(running);
		await expect(row.getByText(running)).toHaveCount(0, { timeout: 15_000 });
		await expect(
			panel.getByRole("button", { name: `Rebuild workspace for ${student.name}` }),
		).toBeEnabled();
	});
}

for (const scheme of ["light", "dark"] as const) {
	test(`a running rebuild on the panel and row has no automatic violations (${scheme})`, async ({
		page,
		browser,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 });
		await page.emulateMedia({ colorScheme: scheme });
		const student = await studentIn(browser, "E2E");
		await query("update workspaces set pending_operation = 'rebuild' where id = $1", [
			student.workspaceId,
		]);
		await openAdmin(page);
		const panel = await openDetail(page, student.name);
		await expect(panel.getByTestId("detail-state")).toHaveText("Rebuilding…");
		const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	});
}

/** The Users table of SPEC.md section 20.1. */
test.describe("the Users table layout", () => {
	test.use({ viewport: { width: 1280, height: 600 } });

	test("five columns, a sticky header, a centred checkbox, no sideways scroll", async ({
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
			"Activity",
		]);

		// The checkbox sits on the middle of the select controls.
		const middle = async (box: { y: number; height: number } | null) =>
			box ? box.y + box.height / 2 : Number.NaN;
		const control = await middle(
			await page.getByTestId("admin-filter-role").boundingBox(),
		);
		const archived = await middle(
			// The input is a 1 px hidden box; the drawn label is what the eye sees.
			await page.locator("label.pk-check", { hasText: "Show archived" }).boundingBox(),
		);
		expect(Math.abs(archived - control)).toBeLessThanOrEqual(1);

		// The header stays in view after <main> scrolls.
		const header = table.getByRole("columnheader", { name: /^Account/ });
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

	test("ticking the first row does not move the table, and the count shows only when filtered", async ({
		page,
	}) => {
		const tag = crypto.randomUUID().slice(0, 8);
		await insertUser(`shift-${tag}-1@example.edu`, `Shift ${tag} 1`, 0);
		await insertUser(`shift-${tag}-2@example.edu`, `Shift ${tag} 2`, 0);
		await openAdmin(page);
		// Nothing hidden and nothing filtered: the heading already counts everyone.
		const [{ archived }] = await query<{ archived: string }>(
			"select count(*) as archived from workspaces where archived_at is not null",
		);
		if (Number(archived) === 0) {
			await expect(page.getByTestId("admin-row-count")).toHaveText("");
		}
		await filterTo(page, `Shift ${tag}`);
		await expect(page.locator("[data-testid^=account-row-]")).toHaveCount(2);
		await expect(page.getByTestId("admin-row-count")).toHaveText(/^Showing 2 of \d+$/);

		const table = page.getByTestId("admin-accounts");
		const before = await table.boundingBox();
		await page.getByRole("checkbox", { name: `Select Shift ${tag} 1` }).check();
		await expect(page.getByTestId("bulk-actions")).toContainText("1 selected");
		await expect(page.getByTestId("admin-row-count")).toHaveText("");
		const after = await table.boundingBox();
		expect(after?.y).toBe(before?.y);
		await page.getByRole("checkbox", { name: `Select Shift ${tag} 1` }).uncheck();
		await expect(page.getByTestId("bulk-actions")).toHaveCount(0);
		expect((await table.boundingBox())?.y).toBe(before?.y);
	});

	test("at 1024 px with the panel open, every column shows and nothing is clipped", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 });
		const tag = crypto.randomUUID().slice(0, 8);
		const longName = `Wide ${tag} Maximiliana Alexandrovna Oyelaran-Featherstonehaugh`;
		const long = await insertUser(
			`maximiliana.alexandrovna.oyelaran-featherstonehaugh-${tag}@students.example.edu`,
			longName,
			40,
		);
		const short = await insertUser(`wide-${tag}@example.edu`, `Wide ${tag} Ada`, 0);
		// A name with no break in it must not push the table wider either.
		await insertUser(`unbroken-${tag}@example.edu`, `Wide${tag}${"W".repeat(60)}`, 0);
		for (const id of [long, short]) {
			const workspace = crypto.randomUUID();
			await query(
				`insert into workspaces (id, owner_user_id, label, incus_instance_name, state, desired_state)
				 values ($1, $2, $3, $4, 'running', 'running')`,
				[
					workspace,
					id,
					`ws-${workspace.slice(0, 8)}`,
					`ws-${workspace.replace(/-/g, "").slice(0, 24)}`,
				],
			);
		}
		// Every tag and the Old image tag at once, on the longest row.
		await routeApi(page, "**/admin/users", async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			for (const user of body.users) {
				if (user.id !== long || !user.workspace) continue;
				user.markers = {
					...user.markers,
					stale: true,
					linked: true,
					duplicateEmail: true,
				};
				user.workspace.image = {
					label: "2026.09.1",
					fingerprint: "old",
					current: false,
				};
				user.workspace.activeConnections = 12;
				const at = new Date().toISOString();
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
		await openAdmin(page);
		await filterTo(page, tag);
		await expect(page.locator("[data-testid^=account-row-]")).toHaveCount(3);
		await expect(page.getByTestId(`account-image-${long}`)).toHaveText("Old image");
		await expect(page.getByTestId(`account-activity-${long}`)).toHaveText(
			"Now, 12 connections",
		);

		await page
			.getByRole("button", { name: `Show details for Wide ${tag} Ada` })
			.click();
		await expect(page.getByRole("region", { name: `Wide ${tag} Ada` })).toBeVisible();

		const table = page.getByTestId("admin-accounts");
		const fit = await table.evaluate((t) => {
			const wrap = (t.parentElement as HTMLElement).getBoundingClientRect();
			const outside = [...t.querySelectorAll("th, td")].filter((cell) => {
				const box = cell.getBoundingClientRect();
				return box.left < wrap.left - 0.5 || box.right > wrap.right + 0.5;
			});
			// A cell whose content is wider than the cell is clipped or spills.
			const spilling = [...t.querySelectorAll("th, td")]
				.filter((cell) => cell.scrollWidth > cell.clientWidth + 1)
				.map((cell) => cell.textContent);
			const tags = [...t.querySelectorAll(".pk-tag")].filter(
				(tag) => tag.getBoundingClientRect().height > 20,
			);
			return {
				outside: outside.length,
				spilling,
				wrappedTags: tags.map((tag) => tag.textContent),
				table: t.scrollWidth,
				wrap: wrap.width,
			};
		});
		expect(fit.outside).toBe(0);
		expect(fit.spilling).toEqual([]);
		// A tag never breaks inside itself ("High memory" stays on one line).
		expect(fit.wrappedTags).toEqual([]);
		expect(fit.table).toBeLessThanOrEqual(Math.ceil(fit.wrap));
		for (const header of ["Account", "Role", "Workspace", "Activity"]) {
			await expect(
				table.getByRole("columnheader", { name: new RegExp(`^${header}`) }),
			).toBeInViewport();
		}
	});

	test("the intro and each help button explain the table, by click and by keyboard", async ({
		page,
	}) => {
		await openAdmin(page);
		const intro = page.getByTestId("intro-admin-users");
		await expect(intro).toContainText(
			"Everyone who has signed in, with their workspace.",
		);
		await expect(intro.getByRole("link", { name: /More in Help/ })).toHaveAttribute(
			"href",
			"/help#admin-users",
		);

		for (const [label, text] of [
			["Account tags", "Stale is about the account, never the workspace"],
			["Role", "only a granted role can be taken away here"],
			["Old image", "Rebuild it to move it to the default image."],
			["Activity", "Now means the workspace is open"],
			["Image filter", "Choose Older to see who needs a rebuild."],
			["Show archived", "cannot start until you unarchive them"],
		] as const) {
			const button = page.getByRole("button", { name: `About ${label}`, exact: true });
			await button.click();
			const tip = openToggletip(page);
			await expect(tip).toContainText(text);
			await page.keyboard.press("Escape");
			await expect(tip).toHaveCount(0);
			await expect(button).toBeFocused();
			// Enter opens it too; hovering never does.
			await page.keyboard.press("Enter");
			await expect(tip).toBeVisible();
			await page.keyboard.press("Escape");
		}
		await page.getByRole("button", { name: "About Activity", exact: true }).hover();
		await expect(openToggletip(page)).toHaveCount(0);
	});
});

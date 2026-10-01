import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
	createStudent,
	loginAs,
	openToggletip,
	query,
	settledAxe,
	WCAG_TAGS,
	WEB_ORIGIN,
} from "./helpers";

/**
 * The Audit tab (SPEC.md §24.11): newest first, pages of 50 by id, filtered
 * by workspace. Each test seeds rows for its own made-up workspace id, so
 * other tests' audit rows never show up in the filtered view.
 */
test.describe("admin audit", () => {
	async function seedEvents(workspaceId: string, count: number): Promise<void> {
		// One statement so the ids rise with `n`: row n = count is the newest.
		await query(
			`insert into audit_events (actor, target, action, result, metadata, at)
			 select 'system', $1, 'workspace.stop_requested', 'success',
			        jsonb_build_object('n', n), now() - make_interval(secs => $2 - n)
			 from generate_series(1, $2::int) as n
			 order by n`,
			[workspaceId, count],
		);
	}

	test("a workspace link filters to that workspace, and Older pages back", async ({
		page,
	}) => {
		const workspaceId = randomUUID();
		const otherId = randomUUID();
		await seedEvents(workspaceId, 55);
		await seedEvents(otherId, 1);

		await loginAs(page, "carol");
		await page.goto(`/admin?tab=audit&workspace=${workspaceId}`);

		const table = page.getByRole("table", { name: /Audit events, newest first/ });
		await expect(table).toBeVisible({ timeout: 15_000 });
		// An unknown target is named by its short ID above the table.
		await expect(page.getByTestId("audit-filter-target")).toContainText(
			`Only events about ${workspaceId.slice(0, 8)}`,
		);
		const rows = table.locator("tbody tr");
		await expect(rows).toHaveCount(50);
		await expect(rows.first()).toContainText("n:55");
		await expect(table).not.toContainText(otherId);

		const pageStatus = page.getByTestId("audit-page");
		await expect(pageStatus).toHaveText("Page 1, 50 events");

		// Paging by keyboard keeps focus on the button, even when it becomes
		// unavailable on the last page (Gate E).
		const older = page.getByRole("button", { name: "Older audit events" });
		await older.focus();
		await page.keyboard.press("Enter");
		await expect(rows).toHaveCount(5);
		await expect(rows.first()).toContainText("n:5");
		await expect(rows.last()).toContainText("n:1");
		await expect(older).toBeDisabled();
		await expect(older).toBeFocused();
		await expect(pageStatus).toHaveText("Page 2, 5 events");

		await page.getByRole("button", { name: "Newer audit events" }).click();
		await expect(rows).toHaveCount(50);
		await expect(rows.first()).toContainText("n:55");
		await expect(pageStatus).toHaveText("Page 1, 50 events");
	});

	test("choosing a person shows their events and their workspace's, by name", async ({
		page,
		browser,
	}) => {
		const context = await browser.newContext({ baseURL: WEB_ORIGIN });
		const student = await createStudent(context, { state: "stopped" });
		await context.close();
		const tag = student.userId.slice(0, 8);
		const name = `Audit Person ${tag}`;
		await query("update users set display_name = $2 where id = $1", [
			student.userId,
			name,
		]);
		const [carol] = await query<{ id: string; display_name: string }>(
			"select id, display_name from users where oidc_subject = 'carol'",
		);
		await query(
			`insert into audit_events (actor, target, action, result, metadata)
			 values ($1, $2, 'e2e.person.account', 'ok', null),
			        ($1, $3, 'e2e.person.workspace', 'ok', null),
			        ('worker', $4, 'e2e.person.other', 'ok', null)`,
			[`user:${carol?.id}`, student.userId, student.workspaceId, randomUUID()],
		);

		await loginAs(page, "carol");
		await page.goto("/admin?tab=audit&action=e2e.person.");
		const table = page.getByRole("table", { name: /Audit events, newest first/ });
		await expect(table).toBeVisible({ timeout: 15_000 });

		const person = page.getByRole("combobox", { name: "Person" });
		// Apply resolves names against the people list, which loads after the table.
		await expect(page.locator(`#audit-people option[value="${name}"]`)).toBeAttached();
		await person.fill(name.toLowerCase());
		const apply = page.getByRole("button", { name: "Apply filters" });
		await apply.click();
		// The filter is the person's ID in the address, so the view can be linked.
		await expect(page).toHaveURL(new RegExp(`user=${student.userId}`));
		await expect(person).toHaveValue(name);

		const rows = table.locator("tbody tr");
		await expect(rows).toHaveCount(2);
		await expect(rows.first()).toContainText("e2e.person.workspace");
		await expect(rows.last()).toContainText("e2e.person.account");
		// Target and actor cells name the people, not their IDs.
		for (const row of [rows.first(), rows.last()]) {
			await expect(row.getByTestId("audit-target-link")).toHaveText(name);
			await expect(row).toContainText(carol?.display_name ?? "");
		}
		// Only the results re-render, so Apply keeps focus (Gate E).
		await expect(apply).toBeFocused();

		// A name that matches nobody is refused at the field.
		await person.fill(`Nobody ${tag}`);
		await apply.click();
		await expect(person).toHaveAttribute("aria-invalid", "true");
		await expect(person).toHaveAccessibleDescription("Choose a person from the list.");
	});

	test("the filter inputs and buttons line up, with and without help or an error", async ({
		page,
	}) => {
		await loginAs(page, "carol");
		await page.goto("/admin?tab=audit");
		const input = page.getByRole("combobox", { name: "Person" });
		const apply = page.getByRole("button", { name: "Apply filters" });
		await expect(apply).toBeVisible({ timeout: 15_000 });
		async function expectAligned() {
			const inputBox = await input.boundingBox();
			const applyBox = await apply.boundingBox();
			if (!inputBox || !applyBox) throw new Error("filter controls have no box");
			expect(
				Math.abs(inputBox.y + inputBox.height - (applyBox.y + applyBox.height)),
			).toBeLessThanOrEqual(1);
		}
		await expectAligned();
		// Action starts with has a help button beside its label; Person has none.
		// Both inputs still start and end on the same lines.
		const action = page.getByRole("textbox", { name: "Action starts with" });
		await expect(
			page.getByRole("button", { name: "About Action starts with" }),
		).toBeVisible();
		const [personBox, actionBox] = await Promise.all([
			input.boundingBox(),
			action.boundingBox(),
		]);
		if (!personBox || !actionBox) throw new Error("filter inputs have no box");
		expect(Math.abs(personBox.y - actionBox.y)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(personBox.height - actionBox.height)).toBeLessThanOrEqual(0.5);
		await input.fill(`nobody-${randomUUID()}`);
		await apply.click();
		await expect(input).toHaveAttribute("aria-invalid", "true");
		await expectAligned();
	});

	test("rows show short IDs, result tags, and a target link that filters", async ({
		page,
	}) => {
		const target = randomUUID();
		const other = randomUUID();
		const [carol] = await query<{ id: string }>(
			"select id from users where oidc_subject = 'carol'",
		);
		const actor = `user:${carol?.id}`;
		// A made-up action prefix keeps other tests' rows out of the first page.
		const prefix = `e2e.t4_${target.slice(0, 8)}.`;
		await query(
			`insert into audit_events (actor, target, action, result, metadata)
			 values ($1, $2, $4 || 'a', 'ok', null),
			        ($1, $2, $4 || 'a', 'denied', null),
			        ('worker', $2, $4 || 'b', 'failure', null),
			        ('worker', $3, $4 || 'b', 'ok', null)`,
			[actor, target, other, prefix],
		);

		await loginAs(page, "carol");
		await page.goto(`/admin?tab=audit&action=${prefix}`);
		const table = page.getByRole("table", { name: /Audit events, newest first/ });
		await expect(table).toBeVisible({ timeout: 15_000 });

		const link = table.getByRole("link", { name: new RegExp(target) }).first();
		await expect(link).toHaveText(target.slice(0, 8));
		await expect(link).toHaveAttribute("title", target);

		await link.click();
		await expect(page).toHaveURL(new RegExp(`workspace=${target}`));
		const targetFilter = page.getByTestId("audit-filter-target");
		await expect(targetFilter).toContainText(target.slice(0, 8));
		await expect(table.locator("tbody tr")).toHaveCount(3);
		await expect(table).not.toContainText(other.slice(0, 8));
		for (const [result, cls] of [
			["ok", /^pk-tag$/],
			["denied", /pk-tag--error/],
			["failure", /pk-tag--error/],
		] as const) {
			await expect(
				table.locator("span.pk-tag", { hasText: new RegExp(`^${result}$`) }).first(),
			).toHaveClass(cls);
		}

		// Show all targets drops the target filter.
		await targetFilter.getByRole("button", { name: "Show all targets" }).click();
		await expect(page).not.toHaveURL(/workspace=/);
		await expect(targetFilter).toHaveCount(0);
	});

	for (const colorScheme of ["light", "dark"] as const) {
		test(`the Audit tab has no automatic accessibility violations (${colorScheme})`, async ({
			page,
			browser,
		}) => {
			const context = await browser.newContext({ baseURL: WEB_ORIGIN });
			const student = await createStudent(context, { state: "stopped" });
			await context.close();
			await query(
				`insert into audit_events (actor, target, action, result, metadata)
				 values ('worker', $1, 'e2e.a11y.named', 'denied', '{"note":"x"}'::jsonb)`,
				[student.workspaceId],
			);

			await page.emulateMedia({ colorScheme });
			await loginAs(page, "carol");
			await page.goto(`/admin?tab=audit&workspace=${student.workspaceId}`);
			await expect(page.getByTestId("audit-target-link")).toHaveText("E2E Student", {
				timeout: 15_000,
			});
			// The error state of the Person field is checked too.
			await page
				.getByRole("combobox", { name: "Person" })
				.fill(`nobody-${randomUUID()}`);
			await page.getByRole("button", { name: "Apply filters" }).click();
			await expect(page.getByRole("combobox", { name: "Person" })).toHaveAttribute(
				"aria-invalid",
				"true",
			);

			await expect(page.getByTestId("intro-admin-audit")).toBeVisible();
			// An open toggletip is checked too; it opens on click and closes on Escape.
			const result = page.getByRole("button", { name: "About Result" });
			await result.click();
			const tip = openToggletip(page);
			await expect(tip).toContainText("denied means Portikus refused it");

			const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
			expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
			await page.keyboard.press("Escape");
			await expect(tip).toBeHidden();
			await expect(result).toBeFocused();
		});
	}
});

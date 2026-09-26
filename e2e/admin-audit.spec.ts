import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { loginAs, query } from "./helpers";

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
		await expect(page.getByLabel("Target ID")).toHaveValue(workspaceId);
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

	test("typing a workspace filter narrows the list", async ({ page }) => {
		const workspaceId = randomUUID();
		await seedEvents(workspaceId, 2);

		await loginAs(page, "carol");
		await page.goto("/admin?tab=audit");
		const table = page.getByRole("table", { name: /Audit events, newest first/ });
		await expect(table).toBeVisible({ timeout: 15_000 });

		await page.getByLabel("Target ID").fill(workspaceId);
		const apply = page.getByRole("button", { name: "Apply filters" });
		await apply.click();
		// The filter is in the address, so the view can be linked.
		await expect(page).toHaveURL(new RegExp(`workspace=${workspaceId}`));

		const rows = table.locator("tbody tr");
		await expect(rows).toHaveCount(2);
		await expect(rows.first()).toContainText(workspaceId.slice(0, 8));
		await expect(rows.first()).toContainText("n:2");
		// Only the results re-render, so Apply keeps focus (Gate E).
		await expect(apply).toBeFocused();
	});

	test("the filter buttons line up with the inputs, with and without an error", async ({
		page,
	}) => {
		await loginAs(page, "carol");
		await page.goto("/admin?tab=audit");
		const input = page.getByLabel("Target ID");
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
		await input.fill("not-an-id");
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
		await expect(page.getByLabel("Target ID")).toHaveValue(target);
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
	});
});

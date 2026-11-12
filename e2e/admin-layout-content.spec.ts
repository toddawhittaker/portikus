import { randomUUID } from "node:crypto";
import { expect, type Locator, test } from "@playwright/test";
import { boxOf, frameLayout, ONE_ROW_WIDTH } from "./admin-frame";
import { DEX_ACCOUNT_ISSUER, loginAs, query } from "./helpers";

/** A panel kept in view beside a long list is capped to what the framed content shows, less its padding. */
async function expectFitsScroller(panel: Locator): Promise<void> {
	const fit = await panel.evaluate((el) => {
		const main = document.querySelector("[data-testid=page-admin]") as HTMLElement;
		return {
			max: Number.parseFloat(getComputedStyle(el).maxHeight),
			room: main.clientHeight - 48,
			height: el.getBoundingClientRect().height,
		};
	});
	expect(fit.max).toBeCloseTo(fit.room, 0);
	expect(fit.height).toBeLessThanOrEqual(fit.max + 0.5);
}

/** The admin content beside the rail: panels, sticky headers and focus kept in view (SPEC.md section 20.1). */
test.describe("admin content layout", () => {
	test.use({ viewport: { width: 1920, height: 1080 } });

	test("at 768 px the Users detail panel stacks under the table, at the table's width", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 768, height: 800 });
		await loginAs(page, "carol");
		await page.goto("/admin/users");
		await page
			.getByTestId("page-admin")
			.getByRole("button", { name: /^Show details for Carol Admin/ })
			.click({ timeout: 15_000 });
		const panel = page.getByTestId("workspace-detail");
		await expect(panel).toBeVisible();
		// The table's frame, which holds its border.
		const table = await boxOf(page.getByTestId("admin-accounts").locator(".."));
		const box = await boxOf(panel);
		expect(box.y).toBeGreaterThan(table.y + table.height);
		expect(box.x).toBeCloseTo(table.x, 0);
		expect(box.width).toBeCloseTo(table.width, 0);
		expect(await panel.evaluate((el) => getComputedStyle(el).position)).toBe("static");
	});

	// The panel sits beside the table, capped to the content's height, at two content heights.
	for (const [width, height] of [
		[ONE_ROW_WIDTH, 600],
		[1920, 800],
	] as const) {
		test(`the Users detail panel fits the framed content at ${width} by ${height} px`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height });
			await loginAs(page, "carol");
			await page.goto("/admin/users");
			await page
				.getByTestId("page-admin")
				.getByRole("button", { name: /^Show details for Carol Admin/ })
				.click({ timeout: 15_000 });
			// The content runs from the header to the status bar beside the rail, so the panel has that height.
			const { headerBox, mainBox, barBox } = await frameLayout(page);
			expect(mainBox.y).toBeCloseTo(headerBox.y + headerBox.height, 0);
			expect(mainBox.y + mainBox.height).toBeCloseTo(barBox.y, 0);
			const panel = page.getByTestId("workspace-detail");
			await expect(panel).toBeVisible();
			await expectFitsScroller(panel);
		});
	}

	test("the Network test panel fits the framed content, and follows it when the content is shorter", async ({
		page,
	}) => {
		// Wide enough for the panel to sit beside the lists.
		await page.setViewportSize({ width: 1440, height: 600 });
		await loginAs(page, "carol");
		await page.goto("/admin/network");
		const panel = page.getByRole("region", { name: "Test a host and refused names" });
		await expect(panel).toBeVisible({ timeout: 15_000 });
		expect(await panel.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
		const before = (await frameLayout(page)).mainBox.height;
		await expectFitsScroller(panel);
		// A taller header leaves the content less height; what shortens it does not matter to the panel.
		await page.addStyleTag({
			content: "[data-testid=app-header] { min-height: 120px !important; }",
		});
		expect((await frameLayout(page)).mainBox.height).toBeLessThan(before - 40);
		await expectFitsScroller(panel);
	});

	test("a secondary button shows its border", async ({ page }) => {
		await loginAs(page, "carol");
		await page.goto("/admin/audit");
		const clear = page.getByTestId("audit-filter-clear");
		await expect(clear).toBeVisible({ timeout: 15_000 });
		const color = await clear.evaluate((el) => getComputedStyle(el).borderTopColor);
		expect(color).not.toBe("rgba(0, 0, 0, 0)");
		expect(color).not.toBe("transparent");
	});

	test("the Audit table header stays in view under the app header when the content scrolls", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 600 });
		const workspaceId = randomUUID();
		await query(
			`insert into audit_events (actor, target, action, result, metadata, at)
			 select 'system', $1, 'workspace.stop_requested', 'success', '{}'::jsonb,
			        now() - make_interval(secs => 50 - n)
			 from generate_series(1, 50) as n order by n`,
			[workspaceId],
		);
		await loginAs(page, "carol");
		await page.goto(`/admin/audit?workspace=${workspaceId}`);

		const table = page.getByTestId("audit-table");
		await expect(table.locator("tbody tr")).toHaveCount(50, { timeout: 15_000 });
		const main = page.getByTestId("page-admin");
		await main.evaluate((el) => el.scrollBy(0, 800));

		const header = table.locator("thead th").first();
		const mainBox = await main.boundingBox();
		const headerBox = await header.boundingBox();
		expect(mainBox).not.toBeNull();
		expect(headerBox).not.toBeNull();
		if (!mainBox || !headerBox) return;
		// Stuck at <main>'s top edge, right under the app header, so no row shows above it.
		expect(Math.abs(headerBox.y - mainBox.y)).toBeLessThanOrEqual(1);
		const appHeader = await boxOf(page.getByTestId("app-header"));
		expect(
			Math.abs(headerBox.y - (appHeader.y + appHeader.height)),
		).toBeLessThanOrEqual(1);
		const firstRow = await table.locator("tbody tr").first().boundingBox();
		expect(firstRow?.y ?? 0).toBeLessThan(mainBox.y);
	});

	test("Shift+Tab up a long Users list never hides the focused row under the header", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 600 });
		const tag = randomUUID().slice(0, 8);
		await query(
			`insert into users (oidc_issuer, oidc_subject, email, display_name, role, last_login_at)
			 select $1, 'e2e-' || $2 || '-' || n, 'focus-' || $2 || '-' || n || '@example.edu',
			        'Focus ' || $2 || ' ' || lpad(n::text, 2, '0'), 'student', now()
			 from generate_series(1, 40) as n`,
			[DEX_ACCOUNT_ISSUER, tag],
		);
		await loginAs(page, "carol");
		await page.goto("/admin");
		const table = page.getByTestId("admin-accounts");
		await expect(table).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("admin-filter-text").fill(`Focus ${tag}`);
		const rows = page.locator("[data-testid^=account-row-]");
		await expect(rows).toHaveCount(40);

		await rows
			.last()
			.getByRole("button", { name: /^Show details for/ })
			.focus();
		const header = table.locator("thead th").first();
		const firstId = await rows
			.first()
			.getByRole("button", { name: /^Show details for/ })
			.getAttribute("id");
		// Press until the first row's name has focus, however many stops a row has.
		let checked = 0;
		let reachedTop = false;
		for (let step = 0; step < 200 && !reachedTop; step++) {
			await page.keyboard.press("Shift+Tab");
			const focused = await page.evaluate(() => {
				const el = document.activeElement as HTMLElement | null;
				return el?.tagName === "BUTTON" && el.id
					? { id: el.id, top: el.getBoundingClientRect().top }
					: null;
			});
			if (focused === null) continue;
			const headerBox = await header.boundingBox();
			if (!headerBox) throw new Error("the header has no box");
			expect(focused.top).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
			checked++;
			reachedTop = focused.id === firstId;
		}
		// The walk really reached every row above the last, up to the first.
		expect(reachedTop).toBe(true);
		expect(checked).toBeGreaterThanOrEqual(39);
	});
});

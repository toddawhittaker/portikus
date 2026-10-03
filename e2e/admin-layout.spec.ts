import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
	createSignedInUser,
	expectNoViolations,
	loginAs,
	MOCK_ISSUER,
	query,
	WEB_ORIGIN,
} from "./helpers";

/** The admin frame every tab shares (SPEC.md section 20.1). */
test.describe("admin layout", () => {
	test.use({ viewport: { width: 1920, height: 1080 } });

	test("content is capped at 1440 px, compact, and each tab has its own h2 and title", async ({
		page,
	}) => {
		await loginAs(page, "carol");
		await page.goto("/admin");

		const main = page.getByTestId("page-admin");
		await expect(main).toHaveAttribute("data-density", "compact", { timeout: 15_000 });
		const box = await page.getByTestId("admin-content").boundingBox();
		expect(box?.width).toBeLessThanOrEqual(1440);
		expect(box?.width).toBeGreaterThan(1400);

		for (const [tab, name] of [
			["users", "Users"],
			["audit", "Audit"],
			["health", "Health"],
			["settings", "Settings"],
		] as const) {
			await page.getByTestId(`admin-tab-${tab}`).click();
			await expect(
				main.getByRole("heading", { level: 2, name, exact: true }),
			).toBeVisible();
			await expect(page).toHaveTitle(`${name}, Administration, Portikus`);
		}
	});

	test("each tab has its own path, the back button moves between tabs, and an old ?tab= link redirects", async ({
		page,
	}) => {
		await loginAs(page, "carol");
		await page.goto("/admin");
		await expect(page).toHaveURL(/\/admin\/users$/, { timeout: 15_000 });

		await page.getByTestId("admin-tab-health").click();
		await expect(page).toHaveURL(/\/admin\/health$/);
		await page.getByTestId("admin-tab-settings").click();
		await expect(page).toHaveURL(/\/admin\/settings$/);
		await page.goBack();
		await expect(page).toHaveURL(/\/admin\/health$/);
		await expect(page.getByTestId("admin-tab-announce")).toHaveText("Health tab");
		await expect(page.getByTestId("admin-tab-health")).toHaveAttribute(
			"aria-current",
			"page",
		);

		// A reload of a deep path serves the page, not the API's JSON.
		await page.reload();
		await expect(page.getByTestId("admin-tab-health")).toHaveAttribute(
			"aria-current",
			"page",
			{
				timeout: 15_000,
			},
		);

		// The Users tab's old value was workspaces; other keys are kept.
		await page.goto("/admin?tab=audit&action=workspace.");
		await expect(page).toHaveURL(/\/admin\/audit\?action=workspace\.$/, {
			timeout: 15_000,
		});
		await page.goto("/admin?tab=workspaces");
		await expect(page).toHaveURL(/\/admin\/users$/, { timeout: 15_000 });
	});

	test("tabs read Users, then Health, Logs, Audit, then Network, Backups, Workspace image, Certificate, Docker, Settings", async ({
		page,
	}) => {
		await loginAs(page, "carol");
		await page.goto("/admin");
		const nav = page.getByRole("navigation", { name: "Administration" });
		await expect(nav.getByRole("link")).toHaveText(
			[
				"Users",
				"Health",
				"Logs",
				"Audit",
				"Network",
				"Backups",
				"Workspace image",
				"Certificate",
				"Docker",
				"Settings",
			],
			{ timeout: 15_000 },
		);
		// A wider gap before each group than between neighbours in a group.
		const left = async (name: string) =>
			(await nav.getByRole("link", { name, exact: true }).boundingBox())?.x ?? 0;
		const right = async (name: string) => {
			const box = await nav.getByRole("link", { name, exact: true }).boundingBox();
			return (box?.x ?? 0) + (box?.width ?? 0);
		};
		const inGroup = (await left("Logs")) - (await right("Health"));
		expect((await left("Health")) - (await right("Users"))).toBeGreaterThan(
			inGroup + 8,
		);
		expect((await left("Network")) - (await right("Audit"))).toBeGreaterThan(
			inGroup + 8,
		);
	});

	for (const width of [1440, 1024]) {
		test(`the tabs sit in the app header and every one fits at ${width} px`, async ({
			page,
			context,
		}) => {
			await page.setViewportSize({ width, height: 800 });
			// A long name and an unread badge: the worst case for the bar's width.
			const { userId } = await createSignedInUser(context, "administrator");
			await query("update users set display_name = $2 where id = $1", [
				userId,
				"Maximiliana Konstantinopoulou-Vanderberg",
			]);
			const recorded = await page.request.post("/me/notifications", {
				data: { tone: "warning", title: "Disk nearly full", body: "" },
				headers: { origin: WEB_ORIGIN },
			});
			expect(recorded.status()).toBe(201);
			await page.goto("/admin/health");
			await expect(page.getByTestId("notifications-badge")).toHaveText("1", {
				timeout: 15_000,
			});
			const header = page.getByTestId("app-header");
			const nav = header.getByRole("navigation", { name: "Administration" });
			await expect(nav.getByRole("link", { name: "Health" })).toHaveAttribute(
				"aria-current",
				"page",
				{ timeout: 15_000 },
			);
			const headerBox = await header.boundingBox();
			const account = await page.getByTestId("me").boundingBox();
			if (!headerBox || !account) throw new Error("the header has no box");
			// The bar keeps its height, and nothing spills past the window.
			expect(headerBox.height).toBe(48);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
				width,
			);
			for (const link of await nav.getByRole("link").all()) {
				const box = await link.boundingBox();
				if (!box) throw new Error("a tab has no box");
				expect(box.y).toBeGreaterThanOrEqual(headerBox.y);
				expect(box.y + box.height).toBeLessThanOrEqual(headerBox.y + headerBox.height);
				expect(box.x + box.width).toBeLessThanOrEqual(account.x);
			}
			// The name may give way to the picture, but the button still says it.
			await expect(page.getByTestId("me")).toHaveAccessibleName(
				/^Maximiliana Konstantinopoulou-Vanderberg, 1 unread notification$/,
			);
			// The badge sits beside the account button, inside the window.
			const badge = await page.getByTestId("notifications-badge").boundingBox();
			expect(badge?.x ?? 0).toBeGreaterThanOrEqual(account.x + account.width);
			expect((badge?.x ?? 0) + (badge?.width ?? 0)).toBeLessThanOrEqual(width);
			// The tab's h2 sits right under the bar: no title or tab row above it.
			const h2 = await page
				.getByTestId("page-admin")
				.getByRole("heading", { level: 2, name: "Health", exact: true })
				.boundingBox();
			expect((h2?.y ?? 0) - (headerBox.y + headerBox.height)).toBeLessThanOrEqual(40);

			// The current tab's underline is the accent, on the bar's bottom edge.
			const underline = await nav
				.getByRole("link", { name: "Health" })
				.evaluate((el) => {
					const after = getComputedStyle(el, "::after");
					const probe = document.createElement("span");
					probe.style.color = getComputedStyle(
						document.documentElement,
					).getPropertyValue("--accent");
					document.body.append(probe);
					const accent = getComputedStyle(probe).color;
					probe.remove();
					return { colour: after.backgroundColor, accent, height: after.height };
				});
			expect(underline.colour).toBe(underline.accent);
			expect(underline.height).toBe("2px");
		});
	}

	test("the keyboard reaches the tabs from the mark, in order, with a visible ring", async ({
		page,
	}) => {
		await loginAs(page, "carol");
		await page.goto("/admin/users");
		const nav = page.getByRole("navigation", { name: "Administration" });
		await expect(nav.getByRole("link", { name: "Users" })).toBeVisible({
			timeout: 15_000,
		});
		await page
			.getByTestId("app-header")
			.getByRole("link", { name: /Portikus/ })
			.focus();
		for (const name of ["Users", "Health", "Logs", "Audit", "Network"]) {
			await page.keyboard.press("Tab");
			const link = nav.getByRole("link", { name, exact: true });
			await expect(link).toBeFocused();
			const outline = await link.evaluate((el) => getComputedStyle(el).outlineStyle);
			expect(outline).toBe("solid");
		}
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/\/admin\/network$/);
		await expect(nav.getByRole("link", { name: "Network" })).toHaveAttribute(
			"aria-current",
			"page",
		);
	});

	for (const scheme of ["light", "dark"] as const) {
		test(`the admin header and its tabs have no automatic violations (${scheme})`, async ({
			page,
		}) => {
			await page.emulateMedia({ colorScheme: scheme });
			await page.setViewportSize({ width: 1024, height: 768 });
			await loginAs(page, "carol");
			await page.goto("/admin/audit");
			await expect(
				page.getByRole("navigation", { name: "Administration" }).getByRole("link", {
					name: "Audit",
				}),
			).toHaveAttribute("aria-current", "page", { timeout: 15_000 });
			await page.getByRole("link", { name: "Logs", exact: true }).focus();
			await expectNoViolations(page, "[data-testid=app-header]");
		});
	}

	test("a secondary button shows its border", async ({ page }) => {
		await loginAs(page, "carol");
		await page.goto("/admin/audit");
		const clear = page.getByTestId("audit-filter-clear");
		await expect(clear).toBeVisible({ timeout: 15_000 });
		const color = await clear.evaluate((el) => getComputedStyle(el).borderTopColor);
		expect(color).not.toBe("rgba(0, 0, 0, 0)");
		expect(color).not.toBe("transparent");
	});

	test("the Audit table header stays in view when the page scrolls", async ({
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
		// Stuck at <main>'s top edge, so no row shows through <main>'s padding above it.
		expect(Math.abs(headerBox.y - mainBox.y)).toBeLessThanOrEqual(1);
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
			[MOCK_ISSUER, tag],
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

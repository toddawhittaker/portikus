import * as crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import { createStudent, loginAs, MOCK_ISSUER, query } from "./helpers";

/**
 * The workspace detail panel's layout (SPEC.md section 20.1,
 * issue #602). Each test makes its own accounts, all named
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

test.describe("at 1280 px", () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test("a full row fits beside the open panel, and the grace Save lines up with its input", async ({
		page,
		browser,
	}) => {
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
		// Image currency needs the worker's host sample, which e2e has none of.
		await page.route("**/admin/users", async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			for (const user of body.users) {
				if (user.workspace) user.workspace.image.current = false;
			}
			await route.fulfill({ response, json: body });
		});

		await loginAs(page, "carol");
		await page.goto("/admin");
		const table = page.getByTestId("admin-accounts");
		await expect(table).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("admin-filter-text").fill(`Fit ${tag}`);
		await expect(page.locator("[data-testid^=account-row-]")).toHaveCount(2);
		await expect(page.getByTestId(`account-image-${student.userId}`)).toHaveText(
			"Older image",
		);

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

		const input = panel.getByTestId(`user-grace-input-${student.userId}`);
		const save = panel.getByTestId(`user-grace-save-${student.userId}`);
		async function expectAligned() {
			const inputBox = await input.boundingBox();
			const saveBox = await save.boundingBox();
			if (!inputBox || !saveBox) throw new Error("grace controls have no box");
			expect(
				Math.abs(inputBox.y + inputBox.height - (saveBox.y + saveBox.height)),
			).toBeLessThanOrEqual(1);
		}
		await input.scrollIntoViewIfNeeded();
		await expectAligned();
		await input.fill("soon");
		await save.click();
		await expect(panel.getByText("Enter a whole number of seconds")).toBeVisible();
		await expectAligned();
	});
});

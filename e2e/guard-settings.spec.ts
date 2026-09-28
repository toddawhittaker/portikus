import { expect, type Page, test } from "@playwright/test";
import { loginAs, query, settledAxe, toast, WCAG_TAGS } from "./helpers";

/**
 * The Resource guard card's saves in the admin Settings tab: the automatic
 * throttle lift (#596, ADR 0032) and the throttle hold (SPEC.md §19.4).
 * Save writes every field of the card to the one settings row, so these
 * tests share a file and run serially; in parallel they overwrite each other.
 */
test.describe.configure({ mode: "serial" });

async function expectNoViolations(page: Page) {
	const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

interface LiftRow {
	cpu_idle_lift_minutes: number;
	cpu_idle_lift_percent: number;
}

async function liftSettings(): Promise<LiftRow> {
	const [row] = await query<LiftRow>(
		"select cpu_idle_lift_minutes, cpu_idle_lift_percent from settings limit 1",
	);
	if (!row) throw new Error("no settings row");
	return row;
}

let saved: LiftRow;

test.beforeAll(async () => {
	saved = await liftSettings();
});

test.afterAll(async () => {
	await query(
		"update settings set cpu_idle_lift_minutes = $1, cpu_idle_lift_percent = $2",
		[saved.cpu_idle_lift_minutes, saved.cpu_idle_lift_percent],
	);
});

test("an administrator saves the quiet time and percent, and they show after a reload", async ({
	page,
}) => {
	await loginAs(page, "carol");
	await page.goto("/admin?tab=settings");
	const guard = page.getByRole("region", { name: "Resource guard" });
	const minutes = guard.getByLabel("Quiet time to lift (minutes)");
	const percent = guard.getByLabel("Quiet below (%)");
	await expect(minutes).toHaveValue(String(saved.cpu_idle_lift_minutes), {
		timeout: 15_000,
	});
	await expect(percent).toHaveValue(String(saved.cpu_idle_lift_percent));

	await minutes.fill("12");
	await percent.fill("0");
	await guard.getByTestId("guard-settings-save").click();
	await expect(toast(page, "Resource guard saved")).toBeVisible();
	expect(await liftSettings()).toEqual({
		cpu_idle_lift_minutes: 12,
		cpu_idle_lift_percent: 0,
	});

	await page.reload();
	await expect(minutes).toHaveValue("12", { timeout: 15_000 });
	await expect(percent).toHaveValue("0");
});

test("out-of-range values are refused with an error tied to each field", async ({
	page,
}) => {
	await loginAs(page, "carol");
	await page.goto("/admin?tab=settings");
	const guard = page.getByRole("region", { name: "Resource guard" });
	const minutes = guard.getByLabel("Quiet time to lift (minutes)");
	const percent = guard.getByLabel("Quiet below (%)");
	await expect(minutes).not.toHaveValue("", { timeout: 15_000 });
	const before = await liftSettings();

	await minutes.fill("61");
	await percent.fill("101");
	await guard.getByTestId("guard-settings-save").click();
	await expect(minutes).toHaveAttribute("aria-invalid", "true");
	await expect(percent).toHaveAttribute("aria-invalid", "true");
	await expect(minutes).toHaveAccessibleDescription(
		"Enter a whole number from 1 to 60.",
	);
	await expect(percent).toHaveAccessibleDescription(
		"Enter 0 to turn it off, or a whole number up to 100.",
	);
	expect(await liftSettings()).toEqual(before);
});

test("an administrator changes the hold settings, and a bad value is named", async ({
	page,
}) => {
	await loginAs(page, "carol");
	await page.goto("/admin?tab=settings");
	const after = page.getByLabel("Hold after throttles");
	const hours = page.getByLabel("Hold window (hours)");
	await expect(after).toHaveValue("3", { timeout: 15_000 });
	await expect(hours).toHaveValue("24");

	await hours.fill("200");
	await page.getByTestId("guard-settings-save").click();
	await expect(page.getByRole("alert")).toHaveText(
		"Enter a whole number from 1 to 168.",
	);
	await expectNoViolations(page);

	try {
		await after.fill("4");
		await hours.fill("48");
		await page.getByTestId("guard-settings-save").click();
		await expect(toast(page, "Resource guard saved")).toBeVisible();
		const [row] = await query<{ after: number; hours: number }>(
			"select cpu_throttle_hold_after as after, cpu_throttle_hold_hours as hours from settings where id = 1",
		);
		expect(row).toEqual({ after: 4, hours: 48 });
		await page.reload();
		await expect(page.getByLabel("Hold after throttles")).toHaveValue("4", {
			timeout: 15_000,
		});
	} finally {
		await query(
			"update settings set cpu_throttle_hold_after = 3, cpu_throttle_hold_hours = 24 where id = 1",
		);
	}
});

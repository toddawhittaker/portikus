import { expect, test } from "@playwright/test";
import {
	expectNoViolations,
	lockSharedState,
	loginAs,
	query,
	SETTINGS_ROW_LOCK,
} from "./helpers";

/**
 * The Resource guard card's saves in the admin Settings tab: the automatic
 * throttle lift (ADR 0032) and the throttle hold (SPEC.md §19.4).
 * Save writes the fields it changed to the one settings row, so these
 * tests share a file, run serially, and hold a lock every worker shares.
 */
test.describe.configure({ mode: "serial" });

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
let release: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
	// The wait for other workers' repeats counts against this hook.
	test.setTimeout(600_000);
	release = await lockSharedState(SETTINGS_ROW_LOCK);
	saved = await liftSettings();
});

test.afterAll(async () => {
	await query(
		"update settings set cpu_idle_lift_minutes = $1, cpu_idle_lift_percent = $2",
		[saved.cpu_idle_lift_minutes, saved.cpu_idle_lift_percent],
	);
	await release?.();
});

test("an administrator saves the quiet time and percent, and they show after a reload", async ({
	page,
}) => {
	await loginAs(page, "carol");
	await page.goto("/admin/settings");
	const guard = page.getByRole("region", { name: "Resource guard" });
	const minutes = guard.getByRole("textbox", { name: "Quiet time" });
	const percent = guard.getByRole("textbox", { name: "Quiet means under" });
	await expect(minutes).toHaveValue(String(saved.cpu_idle_lift_minutes), {
		timeout: 15_000,
	});
	await expect(percent).toHaveValue(String(saved.cpu_idle_lift_percent));

	await minutes.fill("12");
	await percent.fill("0");
	// Nothing is saved until Save.
	expect(await liftSettings()).toEqual({
		cpu_idle_lift_minutes: saved.cpu_idle_lift_minutes,
		cpu_idle_lift_percent: saved.cpu_idle_lift_percent,
	});
	await guard.getByRole("button", { name: "Save resource guard" }).click();
	await expect(page.getByTestId("settings-guard-state")).toHaveText("Saved.");
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
	await page.goto("/admin/settings");
	const guard = page.getByRole("region", { name: "Resource guard" });
	const minutes = guard.getByRole("textbox", { name: "Quiet time" });
	const percent = guard.getByRole("textbox", { name: "Quiet means under" });
	await expect(minutes).not.toHaveValue("", { timeout: 15_000 });
	const before = await liftSettings();

	await minutes.fill("61");
	await percent.fill("101");
	await guard.getByRole("button", { name: "Save resource guard" }).click();
	await expect(minutes).toHaveAttribute("aria-invalid", "true");
	await expect(percent).toHaveAttribute("aria-invalid", "true");
	await expect(minutes).toHaveAccessibleDescription(
		/^minutes Enter a whole number from 1 to 60\./,
	);
	await expect(percent).toHaveAccessibleDescription(
		/Enter 0 to turn the automatic return off, or a whole number up to 100\./,
	);
	await expect(page.getByTestId("settings-guard-state")).toHaveText(
		"Not saved. 2 unsaved changes; fix Quiet time and save again.",
	);
	expect(await liftSettings()).toEqual(before);
});

test("an administrator changes the hold settings, and a bad value is named", async ({
	page,
}) => {
	await loginAs(page, "carol");
	await page.goto("/admin/settings");
	const after = page.getByRole("textbox", { name: "Slowdowns before a hold" });
	const hours = page.getByRole("textbox", { name: "Hold period" });
	await expect(after).toHaveValue("3", { timeout: 15_000 });
	await expect(hours).toHaveValue("24");

	await hours.fill("200");
	await page.getByRole("button", { name: "Save resource guard" }).click();
	await expect(page.locator("#settings-cpuThrottleHoldHours-err")).toHaveText(
		"Enter a whole number from 1 to 168.",
	);
	await expectNoViolations(page);

	try {
		await after.fill("4");
		await hours.fill("48");
		await page.getByRole("button", { name: "Save resource guard" }).click();
		await expect(page.getByTestId("settings-guard-state")).toHaveText("Saved.");
		const [row] = await query<{ after: number; hours: number }>(
			"select cpu_throttle_hold_after as after, cpu_throttle_hold_hours as hours from settings where id = 1",
		);
		expect(row).toEqual({ after: 4, hours: 48 });
		await page.reload();
		await expect(
			page.getByRole("textbox", { name: "Slowdowns before a hold" }),
		).toHaveValue("4", {
			timeout: 15_000,
		});
	} finally {
		await query(
			"update settings set cpu_throttle_hold_after = 3, cpu_throttle_hold_hours = 24 where id = 1",
		);
	}
});

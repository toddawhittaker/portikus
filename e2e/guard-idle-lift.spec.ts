import { expect, test } from "@playwright/test";
import { loginAs, query, toast } from "./helpers";

/**
 * The automatic throttle lift's two platform settings in the admin
 * Settings tab (#596, ADR 0032). The worker does not run here; its lift
 * rule has unit tests.
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

import { expect, type Locator, type Page, test } from "@playwright/test";
import { loginAs, query, settledAxe, toast, WCAG_TAGS } from "./helpers";

/**
 * The Settings tab layout (SPEC.md section 20.1, Epic 25 findings M4 and
 * R3): one column of sections split by hairlines, the resource guard in four
 * groups, the grace period in minutes. These tests write the one settings
 * row, so they run one after another.
 */
test.describe.configure({ mode: "serial" });

async function box(locator: Locator) {
	const found = await locator.boundingBox();
	if (!found) throw new Error("not visible");
	return found;
}

async function open(page: Page) {
	await loginAs(page, "carol");
	await page.goto("/admin?tab=settings");
	await expect(page.getByTestId("guard-settings-save")).toBeEnabled({
		timeout: 15_000,
	});
	await expect(page.getByTestId("grace-input")).not.toHaveValue("");
}

for (const width of [1920, 1024]) {
	test.describe(`at ${width} px`, () => {
		test.use({ viewport: { width, height: 1080 } });

		test("sections stack in one column, with no cards and no log level", async ({
			page,
		}) => {
			await open(page);
			const column = page.getByTestId("settings-sections");
			const sections = column.locator(":scope > section");
			await expect(sections).toHaveCount(3);
			await expect(column.getByRole("heading", { level: 3 })).toHaveText([
				"When workspaces stop",
				"Resource guard",
				"Acceptable use",
			]);
			// Stacked, each below the last, in a column no wider than 72ch.
			const tops = [];
			for (let index = 0; index < 3; index++) {
				tops.push((await box(sections.nth(index))).y);
			}
			expect(tops).toEqual([...tops].sort((a, b) => a - b));
			expect((await box(column)).width).toBeLessThan(700);
			// A hairline, not a card, between sections.
			await expect(sections.nth(1)).toHaveCSS("border-top-width", "1px");
			await expect(sections.nth(1)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
			await expect(page.getByTestId("log-level-select")).toHaveCount(0);
		});

		test("grace and idle stop sit side by side, and every Save is below its fields", async ({
			page,
		}) => {
			await open(page);
			// Both read in one go, so nothing can move between the two.
			const [grace, idle] = await page.evaluate(() =>
				["grace-input", "idle-input"].map((id) => {
					const rect = document
						.querySelector(`[data-testid="${id}"]`)
						?.getBoundingClientRect();
					return { x: rect?.x ?? 0, y: rect?.y ?? 0, right: rect?.right ?? 0 };
				}),
			);
			expect(idle?.y).toBe(grace?.y);
			expect(idle?.x).toBeGreaterThan(grace?.right ?? 0);
			const pairs: [string, string][] = [
				["grace-input", "grace-save"],
				["idle-input", "idle-save"],
				["settings-memoryThresholdPercent", "guard-settings-save"],
				["aup-text", "aup-save"],
			];
			for (const [field, save] of pairs) {
				const above = await box(page.getByTestId(field));
				expect((await box(page.getByTestId(save))).y).toBeGreaterThan(
					above.y + above.height,
				);
			}
		});
	});
}

test("the resource guard is four named groups with one line each and no long paragraph", async ({
	page,
}) => {
	await open(page);
	const guard = page.getByRole("region", { name: "Resource guard" });
	await expect(guard.getByRole("group")).toHaveCount(4);
	const expected: [string, string[]][] = [
		[
			"Slow down heavy CPU use",
			["CPU threshold (%)", "Window (minutes)", "Throttled share (%)"],
		],
		["Give full speed back", ["Quiet time to lift (minutes)", "Quiet below (%)"]],
		["Keep repeat cases slowed", ["Hold after throttles", "Hold window (hours)"]],
		["Flag high memory", ["Memory threshold (%)"]],
	];
	for (const [name, fields] of expected) {
		const group = guard.getByRole("group", { name });
		await expect(group).toBeVisible();
		for (const label of fields) {
			await expect(group.getByLabel(label, { exact: true })).toBeVisible();
		}
		const described = await group.getAttribute("aria-describedby");
		await expect(page.locator(`[id="${described}"]`)).toHaveText(/\.$/);
	}
	for (const key of [
		"cpuThresholdPercent",
		"memoryThresholdPercent",
		"windowMinutes",
	]) {
		expect((await box(page.getByTestId(`settings-${key}`))).width).toBe(208);
	}
	// No paragraph in the section runs past a couple of lines.
	for (const text of await guard.locator("p").allTextContents()) {
		expect(text.split(/\s+/).length).toBeLessThan(30);
	}
});

test("the grace period is shown and saved in minutes, stored in seconds", async ({
	page,
}) => {
	const [before] = await query<{ seconds: number }>(
		"select shutdown_grace_seconds as seconds from settings where id = 1",
	);
	try {
		await open(page);
		const input = page.getByRole("textbox", { name: "Disconnect grace (minutes)" });
		await input.fill("90");
		await expect(page.getByText("1 hour 30 minutes")).toBeVisible();
		// Enter saves: the field sits in its own form.
		await input.press("Enter");
		await expect(toast(page, "Grace period saved")).toBeVisible();
		const [row] = await query<{ seconds: number }>(
			"select shutdown_grace_seconds as seconds from settings where id = 1",
		);
		expect(row?.seconds).toBe(5400);
		await page.reload();
		await expect(page.getByTestId("grace-input")).toHaveValue("90", {
			timeout: 15_000,
		});

		await page.getByTestId("grace-input").fill("ten");
		await page.getByTestId("grace-save").click();
		await expect(page.getByRole("alert")).toHaveText(
			"Enter a number of minutes, 0 or more.",
		);
	} finally {
		await query("update settings set shutdown_grace_seconds = $1 where id = 1", [
			before?.seconds ?? 600,
		]);
	}
});

test("the stop settings work from the keyboard alone", async ({ page }) => {
	const [before] = await query<{ minutes: number }>(
		"select idle_stop_minutes as minutes from settings where id = 1",
	);
	try {
		await open(page);
		await page.getByTestId("grace-input").focus();
		await page.keyboard.press("Tab");
		await expect(page.getByTestId("grace-save")).toBeFocused();
		// The help button beside the next label comes first, then its field.
		await page.keyboard.press("Tab");
		await expect(page.getByRole("button", { name: "About Idle stop" })).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(page.getByTestId("idle-input")).toBeFocused();
		await page.keyboard.press("ControlOrMeta+A");
		await page.keyboard.type("45");
		await page.keyboard.press("Enter");
		await expect(toast(page, "Idle stop saved")).toBeVisible();
		const [row] = await query<{ minutes: number }>(
			"select idle_stop_minutes as minutes from settings where id = 1",
		);
		expect(row?.minutes).toBe(45);
	} finally {
		await query("update settings set idle_stop_minutes = $1 where id = 1", [
			before?.minutes ?? 60,
		]);
	}
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Settings tab has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await open(page);
		// With an error showing, so the error state is checked too.
		await page.getByLabel("Window (minutes)", { exact: true }).fill("1");
		await page.getByTestId("guard-settings-save").click();
		await expect(page.getByRole("alert")).toBeVisible();
		const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	});
}

test("a setting's help opens on click, reads as a dialog, and Escape returns focus", async ({
	page,
}) => {
	await open(page);
	await expect(page.getByTestId("intro-admin-settings")).toContainText(
		"Site-wide rules for when workspaces stop",
	);
	const button = page.getByRole("button", { name: "About Quiet below (%)" });
	await button.click();
	const tip = page.getByRole("dialog", { name: "Quiet below (%)" });
	await expect(tip).toContainText("0 turns the automatic lift off.");
	await page.keyboard.press("Escape");
	await expect(tip).toHaveCount(0);
	await expect(button).toBeFocused();
	// From the keyboard too.
	await page.keyboard.press("Enter");
	await expect(tip).toBeVisible();
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Settings tab with a help tip open has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await open(page);
		await page.getByRole("button", { name: "About Disconnect grace" }).click();
		await expect(page.getByRole("dialog", { name: "Disconnect grace" })).toBeVisible();
		const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	});
}

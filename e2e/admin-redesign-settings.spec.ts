import { expect, type Locator, type Page, test } from "@playwright/test";
import { lockSharedState, loginAs, query, SETTINGS_ROW_LOCK } from "./helpers";

/**
 * The Settings save row (SPEC.md section 20.1): while a section holds
 * unsaved changes its Save and Discard float at the foot of the window, so
 * they stay in reach however far the section runs, and they settle back
 * once nothing is unsaved. These tests write the one settings row, so they
 * hold the lock every settings spec shares.
 */
test.describe.configure({ mode: "serial" });
// Short enough that the Resource guard section runs past the window.
test.use({ viewport: { width: 1280, height: 640 } });

let release: (() => Promise<void>) | undefined;
let savedWindow = 30;

test.beforeAll(async () => {
	// The wait for other workers' settings specs counts against this hook.
	test.setTimeout(600_000);
	release = await lockSharedState(SETTINGS_ROW_LOCK);
	const [row] = await query<{ minutes: number }>(
		"select guard_window_minutes as minutes from settings where id = 1",
	);
	savedWindow = row?.minutes ?? 30;
});

test.afterAll(async () => {
	await query("update settings set guard_window_minutes = $1 where id = 1", [
		savedWindow,
	]);
	await release?.();
});

async function open(page: Page) {
	await loginAs(page, "carol");
	await page.goto("/admin/settings");
	await expect(page.getByTestId("settings-guardWindowMinutes")).not.toHaveValue("", {
		timeout: 15_000,
	});
}

/** Bring the field to the top of the scrolling page, far above its section's foot. */
async function scrollToTop(field: Locator) {
	await field.evaluate((element) => element.scrollIntoView({ block: "start" }));
}

function guard(page: Page) {
	const section = page.getByRole("region", { name: "Resource guard", exact: true });
	return {
		field: page.getByTestId("settings-guardWindowMinutes"),
		state: page.getByTestId("settings-guard-state"),
		save: section.getByRole("button", { name: "Save resource guard" }),
		discard: section.getByRole("button", { name: "Discard changes" }),
	};
}

test("the save row appears on a change, stays in view while scrolling, and Discard puts it away", async ({
	page,
}) => {
	await open(page);
	const g = guard(page);
	const before = await g.field.inputValue();

	// Nothing unsaved: the save row keeps its place at the section's foot, out of view.
	await scrollToTop(g.field);
	await expect(g.state).toHaveText("No unsaved changes.");
	await expect(g.discard).toHaveCount(0);
	await expect(g.save).not.toBeInViewport();

	await g.field.fill(String(Number(before) === 45 ? 50 : 45));
	await expect(g.state).toHaveText("1 unsaved change");
	await expect(g.discard).toBeVisible();
	await expect(g.save).toBeInViewport();
	await expect(g.discard).toBeInViewport();

	// It stays in view wherever the section is scrolled to.
	const height = page.viewportSize()?.height ?? 640;
	for (const offset of [0, 120, 240]) {
		await page.getByTestId("page-admin").evaluate((main, by) => {
			main.scrollBy(0, by);
		}, offset);
		await expect(g.save).toBeInViewport();
		const box = await g.save.boundingBox();
		if (!box) throw new Error("Save has no box");
		expect(box.y + box.height).toBeLessThanOrEqual(height);
	}

	// Discard restores the saved value and the row settles back out of view.
	await g.discard.click();
	await expect(g.field).toHaveValue(before);
	await expect(g.state).toHaveText("No unsaved changes.");
	await expect(g.discard).toHaveCount(0);
	await scrollToTop(g.field);
	await expect(g.save).not.toBeInViewport();
	const [row] = await query<{ minutes: number }>(
		"select guard_window_minutes as minutes from settings where id = 1",
	);
	expect(row?.minutes).toBe(Number(before));
});

test("Save from the floating row saves the change, and the row goes away", async ({
	page,
}) => {
	await open(page);
	const g = guard(page);
	const before = await g.field.inputValue();
	const next = Number(before) === 45 ? 50 : 45;

	await scrollToTop(g.field);
	await g.field.fill(String(next));
	await expect(g.save).toBeInViewport();
	await g.save.click();

	await expect(g.state).toHaveText("Saved.");
	await expect(g.discard).toHaveCount(0);
	const [row] = await query<{ minutes: number }>(
		"select guard_window_minutes as minutes from settings where id = 1",
	);
	expect(row?.minutes).toBe(next);
	// Nothing is unsaved, so it no longer floats over the page.
	await scrollToTop(g.field);
	await expect(g.save).not.toBeInViewport();

	await page.reload();
	await expect(g.field).toHaveValue(String(next), { timeout: 15_000 });
});

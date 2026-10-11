import { expect, type Page } from "@playwright/test";

/**
 * The per-person and daily usage tables line up column for column: each
 * header cell in one has the same left edge and width as its counterpart in
 * the other, within a pixel. Shared by the admin tab and the Course page.
 */
export async function expectUsageColumnsAligned(page: Page): Promise<void> {
	await page.setViewportSize({ width: 1366, height: 900 });
	const boxes = (testId: string) =>
		page
			.getByTestId(testId)
			.locator("thead th")
			.evaluateAll((cells) =>
				cells.map((cell) => {
					const { left, width } = cell.getBoundingClientRect();
					return { left, width };
				}),
			);
	const people = await boxes("agent-usage-users");
	const daily = await boxes("agent-usage-daily");
	expect(people).toHaveLength(10);
	expect(daily).toHaveLength(people.length);
	people.forEach((cell, i) => {
		const other = daily[i];
		if (!other) throw new Error(`the daily table has no column ${i + 1}`);
		expect(
			Math.abs(cell.left - other.left),
			`column ${i + 1} left edge`,
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(cell.width - other.width),
			`column ${i + 1} width`,
		).toBeLessThanOrEqual(1);
	});
	// The tables fit at this width, so the page never scrolls sideways.
	expect(
		await page.evaluate(
			() =>
				document.documentElement.scrollWidth <= document.documentElement.clientWidth,
		),
	).toBe(true);
}

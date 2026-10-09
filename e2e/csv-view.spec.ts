import { expect, test } from "@playwright/test";
import { createStudent, expectNoViolations, openFileTab } from "./helpers";

/**
 * A CSV file opens as a read-only table with its text one button away
 * (SPEC.md §13.2). The table is reachable and scrollable by keyboard
 * (SPEC.md §25.8), draws at most 1,000 rows and says so, and a file that is
 * not valid CSV says so and offers the text.
 */
const MARKS = [
	"name,score,comment",
	"Ann,9,Clear and well tested",
	'"Lee, Bo",7,"Says ""done"" too early"',
	"Cy,8",
	"",
].join("\n");

function rows(count: number): string {
	const lines = ["id,value"];
	for (let at = 1; at <= count; at += 1) lines.push(`${at},row ${at}`);
	return `${lines.join("\n")}\n`;
}

test("a CSV file opens as a table, and Edit and View switch between table and text", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	const student = await createStudent(context);
	const path = "marks.csv";
	await openFileTab(page, student, "Csv", path, MARKS);

	const region = page.getByRole("region", { name: `${path} table` });
	const table = region.getByRole("table");
	await expect(table).toBeVisible({ timeout: 15_000 });
	await expect(table.getByRole("columnheader")).toHaveText([
		"name",
		"score",
		"comment",
	]);
	await expect(table.getByRole("cell", { name: "Lee, Bo" })).toBeVisible();
	await expect(
		table.getByRole("cell", { name: 'Says "done" too early' }),
	).toBeVisible();
	// A short record still fills every column.
	await expect(table.getByRole("row").last().getByRole("cell")).toHaveCount(3);
	await expect(page.getByTestId(`file-view-view-${path}`)).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	await page.getByTestId(`file-view-edit-${path}`).click();
	await expect(page.getByTestId(`editor-${path}`).locator(".view-lines")).toContainText(
		"Lee, Bo",
		{ timeout: 60_000 },
	);
	await expect(page.getByRole("table")).toHaveCount(0);
	await page.getByTestId(`file-view-view-${path}`).click();
	await expect(table).toBeVisible();
});

test("the keyboard reaches the table and scrolls it", async ({ page, context }) => {
	test.setTimeout(90_000);
	const student = await createStudent(context);
	const path = "long.csv";
	await openFileTab(page, student, "Csv keys", path, rows(300));
	const region = page.getByRole("region", { name: `${path} table` });
	await expect(region.getByRole("table")).toBeVisible({ timeout: 15_000 });

	// From the view buttons, Tab moves on into the table's scroll area.
	await page.getByTestId(`file-view-diff-${path}`).focus();
	let reached = false;
	for (let presses = 0; presses < 5 && !reached; presses += 1) {
		await page.keyboard.press("Tab");
		reached = await region.evaluate((node) => node === document.activeElement);
	}
	expect(reached).toBe(true);
	await page.keyboard.press("PageDown");
	await expect.poll(() => region.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
	// The header stays in place while the rows scroll under it.
	const header = region.getByRole("columnheader", { name: "id" });
	const regionTop = (await region.boundingBox())?.y ?? 0;
	expect(Math.abs(((await header.boundingBox())?.y ?? 0) - regionTop)).toBeLessThan(3);
});

test("a large file draws its first 1,000 rows and says how many there are", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	const student = await createStudent(context);
	const path = "big.csv";
	await openFileTab(page, student, "Csv big", path, rows(1500));
	const region = page.getByRole("region", { name: `${path} table` });
	await expect(region.getByRole("table")).toBeVisible({ timeout: 15_000 });
	await expect(region.getByRole("row")).toHaveCount(1001);
	await expect(page.getByTestId("csv-row-cap")).toHaveText(
		"Showing the first 1,000 of 1,500 rows.",
	);
});

test("a file that is not valid CSV says so and opens its text", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	const student = await createStudent(context);
	const path = "broken.csv";
	await openFileTab(page, student, "Csv broken", path, 'name\n"never closed\n');
	await expect(
		page.getByRole("heading", { name: "This file could not be read as CSV" }),
	).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: "Show as text" }).click();
	await expect(page.getByTestId(`editor-${path}`).locator(".view-lines")).toContainText(
		"never closed",
		{ timeout: 60_000 },
	);
	await expect(page.getByTestId(`file-view-edit-${path}`)).toHaveAttribute(
		"aria-pressed",
		"true",
	);
});

for (const scheme of ["light", "dark"] as const) {
	test(`the CSV table has no automatic accessibility violations (${scheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme: scheme });
		const student = await createStudent(context);
		const path = "marks.csv";
		await openFileTab(page, student, `A11y csv ${scheme}`, path, MARKS);
		await expect(page.getByRole("region", { name: `${path} table` })).toBeVisible({
			timeout: 15_000,
		});
		await expectNoViolations(page);
		await page.getByRole("region", { name: `${path} table` }).focus();
		await expectNoViolations(page);
	});

	test(`a CSV file that cannot be read has no automatic accessibility violations (${scheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme: scheme });
		const student = await createStudent(context);
		await openFileTab(page, student, `A11y bad csv ${scheme}`, "bad.csv", '"open\n');
		await expect(page.getByRole("button", { name: "Show as text" })).toBeVisible({
			timeout: 15_000,
		});
		await expectNoViolations(page);
	});
}

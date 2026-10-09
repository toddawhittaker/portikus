import { expect, test } from "@playwright/test";
import { createStudent, openFileTab } from "./helpers";

/**
 * Reference-style links and images, `[text][id]` with the address defined
 * elsewhere, render in the Markdown preview like inline ones (SPEC.md §13.4).
 */
test("reference-style links and images render and their definitions do not", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	const student = await createStudent(context);
	const content = [
		"See [the docs][docs].",
		"",
		"![Logo][logo]",
		"",
		"[docs]: https://example.invalid/docs",
		"[logo]: ./logo.png",
		"",
	].join("\n");
	await openFileTab(page, student, "Refs", "README.md", content);

	const preview = page.getByTestId("markdown-preview");
	await expect(preview).toBeVisible({ timeout: 30_000 });
	await expect(preview.getByRole("link", { name: "the docs" })).toHaveAttribute(
		"href",
		"https://example.invalid/docs",
	);
	await expect(preview.getByRole("img", { name: "Logo" })).toHaveAttribute(
		"src",
		/path=logo\.png/,
	);
	await expect(preview).not.toContainText("[docs]:");
});

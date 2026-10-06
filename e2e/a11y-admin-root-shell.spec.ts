/**
 * Automated accessibility checks (SPEC.md section 25.8) on the admin Root
 * shell tab (ADR 0051): the empty tab, then two shells side by side, in the
 * light and dark themes and at the narrowest admin window.
 */
import { expect, test } from "@playwright/test";
import { createSignedInUser, expectNoViolations } from "./helpers";

for (const scheme of ["light", "dark"] as const) {
	test(`the Root shell tab has no automatic violations (${scheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		// The smallest admin window (SPEC.md section 20.1).
		await page.setViewportSize({ width: 768, height: 720 });
		await createSignedInUser(page.context(), "administrator");
		await page.goto("/admin/shell");
		await expect(page.getByText("No root shells open")).toBeVisible({
			timeout: 15_000,
		});
		await expectNoViolations(page);

		await page.getByRole("button", { name: "Open a root shell" }).click();
		const leaf = page.locator('[data-testid^="terminal-leaf-"]').first();
		const id = ((await leaf.getAttribute("data-testid")) ?? "").replace(
			"terminal-leaf-",
			"",
		);
		await expect(page.getByTestId(`terminal-pane-${id}`)).toHaveAttribute(
			"data-connected",
			"true",
			{ timeout: 15_000 },
		);
		await page.getByTestId(`terminal-actions-${id}`).click();
		await page.getByTestId("split-right").click();
		await expect(page.locator('[data-testid^="terminal-leaf-"]')).toHaveCount(2);
		const input = page.locator(
			`[data-testid="terminal-pane-${id}"] .xterm-helper-textarea`,
		);
		await expect(input).toHaveAccessibleDescription(/Alt\+Shift\+Q/);
		await expectNoViolations(page);
	});
}

test("Alt+Shift+Q leaves a root shell for its tab", async ({ page }) => {
	await createSignedInUser(page.context(), "administrator");
	await page.goto("/admin/shell");
	await page.getByRole("button", { name: "Open a root shell" }).click();
	const tab = page.getByRole("tab", { name: "Root shell 1" });
	await expect(tab).toBeVisible({ timeout: 15_000 });
	await page.locator(".xterm-screen").click();
	await page.keyboard.press("Alt+Shift+Q");
	await expect(tab).toBeFocused();
});

import { expect, test } from "@playwright/test";
import { expectNoViolations, expectReflowAt320 } from "./helpers";

/**
 * The signed-out standalone pages reflow at 320 px without sideways
 * scrolling, in light and dark (SPEC.md section 25.8, WCAG 1.4.10). Someone
 * may open a sign-in or reset link on a phone. The pages that need a
 * session are checked in their own a11y specs.
 */
const PAGES = [
	{ path: "/", testId: "page-signin" },
	{ path: "/session-ended", testId: "page-session-ended" },
	{ path: "/not-invited", testId: "page-not-invited" },
	{ path: "/unlinked", testId: "page-unlinked" },
	{ path: "/not-authorized", testId: "page-not-authorized" },
	{ path: "/no-such-page", testId: "page-not-found" },
];

for (const colorScheme of ["light", "dark"] as const) {
	test(`the signed-out standalone pages fit 320 px (${colorScheme})`, async ({
		page,
	}) => {
		// Six pages, each loaded and checked with axe, in one test.
		test.slow();
		await page.emulateMedia({ colorScheme });
		for (const { path, testId } of PAGES) {
			await page.setViewportSize({ width: 1280, height: 800 });
			await page.goto(path);
			// A first load from the dev server can be slow under a busy run.
			await expect(page.getByTestId(testId)).toBeVisible({ timeout: 15_000 });
			await expectReflowAt320(page);
			await expectNoViolations(page);
		}
	});
}

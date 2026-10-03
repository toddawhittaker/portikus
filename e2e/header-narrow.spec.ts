/**
 * The app header on a narrow window: the Course page opens in a tab of its
 * own, which may be small, and the header must stay one line (SPEC.md 25.8).
 */
import { expect, type Locator, test } from "@playwright/test";
import { expectNoViolations, WEB_ORIGIN } from "./helpers";
import { launchAs, openCourseTab } from "./lti-helpers";

/** How many lines the element's visible text takes; a wrapped name takes two. */
function textLines(locator: Locator): Promise<number> {
	return locator.evaluate((el) => {
		const tops = new Set<number>();
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (!node.textContent?.trim()) continue;
			const range = document.createRange();
			range.selectNodeContents(node);
			for (const rect of range.getClientRects()) {
				if (rect.width > 1) tops.add(Math.round(rect.bottom));
			}
		}
		return tops.size;
	});
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`on the Course page at 480 px the header fits on one line (${colorScheme})`, async ({
		browser,
	}) => {
		const context = await browser.newContext({ baseURL: WEB_ORIGIN, colorScheme });
		try {
			const page = await context.newPage();
			await launchAs(page, { person: "tom", course: "cs240" });
			const course = await openCourseTab(page);
			await course.setViewportSize({ width: 480, height: 800 });
			const header = course.getByTestId("app-header");
			const back = header.getByTestId("back-to-workspace");
			await expect(back).toBeVisible({ timeout: 15_000 });

			const headerBox = await header.boundingBox();
			if (!headerBox) throw new Error("the header has no box");
			expect(headerBox.height).toBe(48);
			// The bar itself never scrolls sideways, whatever the page below does.
			expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
				true,
			);
			for (const item of [back, header.getByTestId("me")]) {
				const box = await item.boundingBox();
				if (!box) throw new Error("a header control has no box");
				expect(box.y).toBeGreaterThanOrEqual(headerBox.y);
				expect(box.x + box.width).toBeLessThanOrEqual(480);
				expect(await textLines(item)).toBe(1);
			}
			// Shortened on screen, the names are still whole.
			await expect(back).toHaveAccessibleName("Back to your workspace");
			await expect(header.getByTestId("me")).toHaveAccessibleName(/\S/);
			const name = await header.getByTestId("me").getAttribute("aria-label");
			expect(name?.length ?? 0).toBeGreaterThan(2);
			await expectNoViolations(course, "[data-testid=app-header]");
		} finally {
			await context.close();
		}
	});
}

test("on the Course page at 768 px the header still shows the name", async ({
	browser,
}) => {
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		const page = await context.newPage();
		await launchAs(page, { person: "tom", course: "cs240" });
		const course = await openCourseTab(page);
		await course.setViewportSize({ width: 768, height: 800 });
		const me = course.getByTestId("me");
		await expect(me.locator(".pk-account-name")).toBeVisible({ timeout: 15_000 });
		expect(await textLines(me)).toBe(1);
		expect(await textLines(course.getByTestId("back-to-workspace"))).toBe(1);
	} finally {
		await context.close();
	}
});

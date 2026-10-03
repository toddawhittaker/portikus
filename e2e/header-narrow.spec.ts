/**
 * The app header on a narrow window: the Course page opens in a tab of its
 * own, which may be small, and the header must stay one line with every
 * control on screen, down to 320 px (SPEC.md 25.8, WCAG 1.4.10 Reflow).
 * Where the bar shows only the picture, the account menu names the account.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoViolations, loginAs, WEB_ORIGIN } from "./helpers";
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

/**
 * Tom teaches one course, so /course redirects to it and the lazy members
 * page mounts a new header. Measuring before the members table shows races
 * that swap, and finds no header or an empty one.
 */
async function openCoursePage(page: Page, width: number): Promise<Page> {
	await launchAs(page, { person: "tom", course: "cs240" });
	const course = await openCourseTab(page);
	await course.setViewportSize({ width, height: 800 });
	await expect(course).toHaveURL(/\/course\/[0-9a-f-]{36}$/, { timeout: 15_000 });
	await expect(course.getByTestId("course-members")).toBeVisible({ timeout: 15_000 });
	return course;
}

for (const width of [320, 480]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test(`on the Course page at ${width} px the header fits on one line (${colorScheme})`, async ({
			browser,
		}) => {
			const context = await browser.newContext({ baseURL: WEB_ORIGIN, colorScheme });
			try {
				const course = await openCoursePage(await context.newPage(), width);
				const header = course.getByTestId("app-header");
				const back = header.getByTestId("back-to-workspace");
				const me = header.getByTestId("me");
				await expect(back).toBeVisible();

				const headerBox = await header.boundingBox();
				if (!headerBox) throw new Error("the header has no box");
				expect(headerBox.height).toBe(48);
				// Neither the bar nor the page scrolls sideways.
				expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
					true,
				);
				expect(
					await course.evaluate(
						() =>
							document.documentElement.scrollWidth <=
							document.documentElement.clientWidth,
					),
				).toBe(true);
				for (const item of [back, me]) {
					const box = await item.boundingBox();
					if (!box) throw new Error("a header control has no box");
					expect(box.x).toBeGreaterThanOrEqual(0);
					expect(box.y).toBeGreaterThanOrEqual(headerBox.y);
					expect(box.x + box.width).toBeLessThanOrEqual(width);
					expect(await textLines(item)).toBe(1);
				}
				// Shortened on screen, the names are still whole.
				await expect(back).toHaveAccessibleName("Back to your workspace");
				await expect(back).toHaveText(
					width === 320 ? "Workspace" : "Back to your workspace",
					{ useInnerText: true },
				);
				await expect(header.getByRole("link", { name: "Portikus" })).toBeVisible();
				const name = await me.getAttribute("aria-label");
				expect(name?.length ?? 0).toBeGreaterThan(2);

				// The account button is reached by keyboard and its focus ring is on screen.
				await back.focus();
				await course.keyboard.press("Tab");
				await expect(me).toBeFocused();
				const focused = await me.boundingBox();
				if (!focused) throw new Error("the account button has no box");
				expect(focused.x + focused.width).toBeLessThanOrEqual(width);
				await expectNoViolations(course);
			} finally {
				await context.close();
			}
		});
	}
}

test("on the Course page at 768 px the header still shows the name", async ({
	browser,
}) => {
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		const course = await openCoursePage(await context.newPage(), 768);
		const header = course.getByTestId("app-header");
		const me = header.getByTestId("me");
		await expect(me.locator(".pk-account-name")).toBeVisible();
		await expect(header.getByText("Portikus", { exact: true })).toBeVisible();
		expect(await textLines(me)).toBe(1);
		const back = header.getByTestId("back-to-workspace");
		await expect(back).toHaveText("Back to your workspace", { useInnerText: true });
		expect(await textLines(back)).toBe(1);
	} finally {
		await context.close();
	}
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`where the bar shows only the picture, the account menu names the account (${colorScheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await page.setViewportSize({ width: 1024, height: 768 });
		await loginAs(page, "carol");
		await page.goto("/admin");
		await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
		const me = page.getByTestId("me");
		await expect(me.locator(".pk-account-name")).toBeHidden();

		await me.focus();
		await page.keyboard.press("Enter");
		const menu = page.getByRole("menu", { name: "Carol Admin" });
		await expect(menu).toBeVisible();
		const name = menu.getByTestId("account-menu-name");
		await expect(name).toHaveText("Carol Admin");
		const address = menu.getByTitle("carol@example.edu");
		await expect(address).toHaveText("carol@example.edu");
		// The name over the address, the name in body text and the address muted.
		const [nameBox, addressBox] = [
			await name.boundingBox(),
			await address.boundingBox(),
		];
		if (!nameBox || !addressBox) throw new Error("the menu label has no box");
		expect(addressBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 1);
		const look = (el: Element) => ({
			size: getComputedStyle(el).fontSize,
			color: getComputedStyle(el).color,
		});
		const [nameLook, addressLook] = [
			await name.evaluate(look),
			await address.evaluate(look),
		];
		expect(nameLook.size).toBe("14px");
		expect(addressLook.size).toBe("12px");
		expect(nameLook.color).not.toBe(addressLook.color);
		await expectNoViolations(page, '[role="menu"]');
		await page.keyboard.press("Escape");
		await expect(me).toBeFocused();
	});
}

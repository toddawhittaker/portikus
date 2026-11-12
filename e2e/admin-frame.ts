import type { Locator, Page } from "@playwright/test";

/** The narrowest desktop window tested; the rail holds every tab whole beside the content here. */
export const ONE_ROW_WIDTH = 1366;

export type Box = { x: number; y: number; width: number; height: number };

export async function boxOf(locator: Locator): Promise<Box> {
	const box = await locator.boundingBox();
	if (!box) throw new Error("an element of the admin frame has no box");
	return box;
}

/** The header, the section rail, the frame, the scrolling content and the status bar, as drawn now. */
export async function frameLayout(page: Page) {
	return {
		headerBox: await boxOf(page.getByTestId("app-header")),
		railBox: await boxOf(page.getByRole("navigation", { name: "Administration" })),
		frameBox: await boxOf(page.getByTestId("admin-frame")),
		mainBox: await boxOf(page.getByTestId("page-admin")),
		barBox: await boxOf(page.getByTestId("admin-status-bar")),
	};
}

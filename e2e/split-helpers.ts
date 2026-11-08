import type { Page } from "@playwright/test";

/** What a pane's Split right or Split down submenu can open. */
export type SplitChoice = "terminal" | "claude" | "claude-gui" | "codex";

/**
 * Split a pane from its menu, choosing what the new pane opens. The pointer
 * glides to the submenu item as a hand would: Radix closes a submenu the
 * pointer jumps out of in one step, which Playwright's own click does.
 */
export async function splitPane(
	page: Page,
	paneId: string,
	side: "right" | "down",
	choice: SplitChoice = "terminal",
): Promise<void> {
	await page.getByTestId(`terminal-actions-${paneId}`).click();
	await page.getByTestId(`split-${side}`).click();
	const item = page.getByTestId(`split-${side}-${choice}`);
	await item.waitFor();
	const box = await item.boundingBox();
	if (!box) throw new Error("the split submenu did not open");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
	await item.click();
}

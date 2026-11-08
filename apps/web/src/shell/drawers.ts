/** The side panes that become drawers at phone widths, and their element ids (SPEC.md §8.1). */
export const DRAWER_IDS = {
	projects: "projects-drawer",
	files: "files-drawer",
} as const;

export type DrawerName = keyof typeof DRAWER_IDS;

interface TabsState {
	layout: { tabs: readonly { id: string }[] };
	activeTabId: string | null;
}

/**
 * True when the work area gained a tab or the student switched to another
 * open one, which shows the work area; false when a tab closed on its own.
 */
export function openedTab(previous: TabsState, next: TabsState): boolean {
	const before = new Set(previous.layout.tabs.map((tab) => tab.id));
	if (next.layout.tabs.some((tab) => !before.has(tab.id))) return true;
	if (next.activeTabId === previous.activeTabId || previous.activeTabId === null)
		return false;
	return next.layout.tabs.some((tab) => tab.id === previous.activeTabId);
}

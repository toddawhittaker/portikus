/**
 * The part of a project's layout that belongs to this browser rather than to
 * the saved document: which tab is selected and where the cursor and scroll
 * sit in each open file (SPEC.md §7.5 says the selected tab is browser-local,
 * issue #161). It lives in localStorage, which some browsers refuse, so every
 * access is guarded.
 */

export interface LocalLayout {
	activeTabId: string | null;
	/** Monaco's own view state per project-relative path, opaque to us. */
	viewStates: Record<string, unknown>;
}

function key(projectId: string): string {
	return `portikus.layout.${projectId}`;
}

export function readLocalLayout(projectId: string): LocalLayout | null {
	try {
		const raw = localStorage.getItem(key(projectId));
		if (raw === null) return null;
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const record = parsed as Partial<LocalLayout>;
		const activeTabId =
			typeof record.activeTabId === "string" ? record.activeTabId : null;
		const viewStates =
			typeof record.viewStates === "object" && record.viewStates !== null
				? (record.viewStates as Record<string, unknown>)
				: {};
		return { activeTabId, viewStates };
	} catch {
		// Unreadable or corrupt: the student simply starts on the first tab.
		return null;
	}
}

export function writeLocalLayout(projectId: string, state: LocalLayout): void {
	try {
		localStorage.setItem(key(projectId), JSON.stringify(state));
	} catch {
		// A full or blocked store only costs the cursor position.
	}
}

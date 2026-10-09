/**
 * Where the keyboard goes when a pane goes away, so it never falls to the
 * page body (SPEC.md §25.8): the next pane in the same tab, terminal or
 * file, else the one before it, else the caller's fallback, such as the New
 * tab button.
 */
import type { ProjectLayout } from "@portikus/contracts";
import { fileTabId, paneIds } from "../layout/tree.js";

/** The pane in the same tab that takes over from `paneId`, if any. */
export function neighbourPane(layout: ProjectLayout, paneId: string): string | null {
	for (const tab of layout.tabs) {
		const ids = paneIds(tab.root);
		const index = ids.indexOf(paneId);
		if (index < 0) continue;
		return ids[index + 1] ?? ids[index - 1] ?? null;
	}
	return null;
}

/**
 * The keyboard input of a pane on screen: a terminal's, or a file's editor,
 * else the file pane's actions button when it shows no editor.
 */
function paneInput(paneId: string): HTMLElement | null {
	const files = fileTabId("");
	if (!paneId.startsWith(files)) {
		return document.querySelector<HTMLElement>(
			`[data-testid="terminal-pane-${CSS.escape(paneId)}"] .xterm-helper-textarea`,
		);
	}
	const path = CSS.escape(paneId.slice(files.length));
	const frame = document.querySelector(`[data-testid="file-frame-${path}"]`);
	// Monaco takes keys in an edit-context element, or a textarea where the
	// browser has no EditContext.
	return (
		frame?.querySelector<HTMLElement>(
			".monaco-editor .native-edit-context, .monaco-editor textarea.inputarea",
		) ??
		frame?.querySelector<HTMLElement>(`[data-testid="file-frame-actions-${path}"]`) ??
		null
	);
}

/**
 * Move the keyboard off a pane that is closing: into its neighbour, whose id
 * is returned so the caller can mark it focused, or else to `fallback`.
 */
export function focusAfterPane(
	layout: ProjectLayout,
	paneId: string,
	fallback: HTMLElement | null | undefined,
): string | null {
	const next = neighbourPane(layout, paneId);
	const input = next ? paneInput(next) : null;
	if (next && input) {
		input.focus();
		return next;
	}
	fallback?.focus();
	return null;
}

/**
 * The tab that becomes active when `closingTabId` closes: the one active
 * before it, as the layout store picks, else the neighbour on the left, then
 * the right. Null when no tab is left.
 */
export function tabAfterClose(
	layout: ProjectLayout,
	closingTabId: string,
	history: readonly string[],
): string | null {
	const remaining = layout.tabs.filter((tab) => tab.id !== closingTabId);
	const fromHistory = history.find((id) => remaining.some((tab) => tab.id === id));
	if (fromHistory) return fromHistory;
	const index = layout.tabs.findIndex((tab) => tab.id === closingTabId);
	return remaining[index - 1]?.id ?? remaining[index]?.id ?? remaining[0]?.id ?? null;
}

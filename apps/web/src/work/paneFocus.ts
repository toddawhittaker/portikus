/**
 * Where the keyboard goes when a terminal pane goes away, so it never falls
 * to the page body (SPEC.md §25.8): the next pane in the same tab, else the
 * one before it, else the caller's fallback, such as the New tab button.
 */
import type { ProjectLayout } from "@portikus/contracts";
import { terminalIds } from "../layout/tree.js";

/** The pane in the same tab that takes over from `terminalId`, if any. */
export function neighbourPane(
	layout: ProjectLayout,
	terminalId: string,
): string | null {
	for (const tab of layout.tabs) {
		const ids = terminalIds(tab.root);
		const index = ids.indexOf(terminalId);
		if (index < 0) continue;
		return ids[index + 1] ?? ids[index - 1] ?? null;
	}
	return null;
}

/** The keyboard input of a terminal pane on screen. */
function terminalInput(terminalId: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(
		`[data-testid="terminal-pane-${terminalId}"] .xterm-helper-textarea`,
	);
}

/**
 * Move the keyboard off a pane that is closing: into its neighbour, whose id
 * is returned so the caller can mark it focused, or else to `fallback`.
 */
export function focusAfterPane(
	layout: ProjectLayout,
	terminalId: string,
	fallback: HTMLElement | null | undefined,
): string | null {
	const next = neighbourPane(layout, terminalId);
	const input = next ? terminalInput(next) : null;
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

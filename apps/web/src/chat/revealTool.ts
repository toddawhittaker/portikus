/**
 * Showing one tool row of a chat on request, such as a subagent picked in the
 * project list (SPEC.md §8.2). The request outlives the click, because the
 * chat may still be mounting or loading its conversation when it is made.
 */
import { type RefObject, useLayoutEffect, useSyncExternalStore } from "react";

/**
 * Tool ids come from the URL's checked `subagent` parameter, letters, digits,
 * `_` and `-` only, so the id is safe inside the selector as it is.
 *
 * Open the tool row with this id and every folded section around it, scroll it
 * into view and put the keyboard on it. False when the row is not there yet.
 */
export function revealTool(root: ParentNode, toolId: string): boolean {
	const row = root.querySelector<HTMLDetailsElement>(
		`details[data-testid="chat-tool-${toolId}"]`,
	);
	if (!row) return false;
	for (
		let details: HTMLDetailsElement | null = row;
		details !== null;
		details = details.parentElement?.closest("details") ?? null
	) {
		details.open = true;
	}
	const summary = row.querySelector<HTMLElement>(":scope > summary") ?? row;
	summary.scrollIntoView({ block: "center" });
	summary.focus({ preventScroll: true });
	return true;
}

/** The tool row each chat terminal still has to show, by terminal id. */
const pending = new Map<string, string>();
const listeners = new Set<() => void>();

function changed() {
	for (const listener of listeners) listener();
}

/** Ask a chat to show one of its tool rows; a newer request replaces an older one. */
export function requestToolReveal(terminalId: string, toolId: string): void {
	pending.set(terminalId, toolId);
	changed();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Carry out a request for this chat once it is on screen and the row has
 * arrived. `content` changes whenever the conversation does, so a row that
 * arrives later is still found.
 */
export function useToolReveal(
	terminalId: string,
	root: RefObject<HTMLElement | null>,
	visible: boolean,
	content: unknown,
): void {
	const toolId = useSyncExternalStore(subscribe, () => pending.get(terminalId));
	// biome-ignore lint/correctness/useExhaustiveDependencies: `content` is the trigger to look again
	useLayoutEffect(() => {
		if (toolId === undefined || !visible || !root.current) return;
		if (!revealTool(root.current, toolId)) return;
		if (pending.get(terminalId) === toolId) pending.delete(terminalId);
		changed();
	}, [terminalId, toolId, visible, content, root]);
}

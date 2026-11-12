/**
 * Opening a subagent's read-only view in its chat (SPEC.md §8.2, §10.8):
 * from an Agent card, through the context the chat (or the view itself, for
 * a nested subagent) provides, and from the project list, through a request
 * the chat picks up once it is on screen. The chat's own row in the list
 * asks it to close the view the same way.
 */
import { createContext, useSyncExternalStore } from "react";

/** One subagent to show: its Agent tool call and the words to name it by. */
export interface SubagentTarget {
	toolUseId: string;
	title: string;
}

/** Open a subagent's view; null where no view can open. */
export const SubagentOpenerContext = createContext<
	((target: SubagentTarget) => void) | null
>(null);

/** What each chat terminal still has to do with its view, by terminal id: null closes it. */
const pending = new Map<string, SubagentTarget | null>();
const listeners = new Set<() => void>();

/** Ask a chat to open a subagent's view; a newer request replaces an older one. */
export function requestSubagentView(terminalId: string, target: SubagentTarget): void {
	pending.set(terminalId, target);
	for (const listener of listeners) listener();
}

/** Ask a chat to close its subagent view, if one is open. */
export function requestSubagentClose(terminalId: string): void {
	pending.set(terminalId, null);
	for (const listener of listeners) listener();
}

/** Take this chat's request, so it is carried out once; undefined when there is none. */
export function takeSubagentRequest(
	terminalId: string,
): SubagentTarget | null | undefined {
	const target = pending.get(terminalId);
	if (pending.delete(terminalId)) for (const listener of listeners) listener();
	return target;
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** The request waiting for this chat: a subagent to show, null to close, undefined for none. */
export function useSubagentRequest(
	terminalId: string,
): SubagentTarget | null | undefined {
	return useSyncExternalStore(subscribe, () => pending.get(terminalId));
}

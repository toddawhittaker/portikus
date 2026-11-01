/**
 * What the student's coding agents are doing, and which finished or waiting
 * agents they have not looked at yet. The state arrives as a whole list on the
 * workspace socket; unread marks live only in page memory (SPEC.md §10.8).
 */
import type { CodingAgentState, CodingAgentTerminal } from "@portikus/contracts";
import { createContext, useContext, useSyncExternalStore } from "react";
import { CODING_AGENT_NAME } from "../admin/image/codingAgents.js";

/** The toast title for an agent that stopped: "Claude Code needs your input". */
export function alertTitle(
	agent: CodingAgentTerminal["agent"],
	state: Extract<CodingAgentState, "needs-input" | "finished">,
): string {
	return `${CODING_AGENT_NAME[agent]} ${state === "finished" ? "finished" : "needs your input"}`;
}

/** What a tab or a project row shows for one or more terminals. */
export interface AgentMark {
	state: CodingAgentState;
	unread: boolean;
}

/**
 * Needs input outranks an unread finish, which outranks working. A finish the
 * student has seen shows nothing, so it ranks zero.
 */
export function urgency(mark: AgentMark): number {
	if (mark.state === "needs-input") return 3;
	if (mark.state === "finished") return mark.unread ? 2 : 0;
	return 1;
}

/** The most urgent mark worth showing, or null when there is none. */
export function mostUrgent(marks: Iterable<AgentMark>): AgentMark | null {
	let best: AgentMark | null = null;
	for (const mark of marks) {
		if (urgency(mark) > (best ? urgency(best) : 0)) best = mark;
	}
	return best;
}

/** One alert: an agent changed to finished or needs input while out of sight. */
export interface AgentAlert {
	terminalId: string;
	projectId: string;
	agent: CodingAgentTerminal["agent"];
	state: Extract<CodingAgentState, "needs-input" | "finished">;
}

interface Reconciled {
	unread: ReadonlySet<string>;
	alerts: AgentAlert[];
}

/**
 * Works out the unread set and the alerts for a new list. The first list after
 * a connection only sets the baseline: what was already true is not news.
 */
function reconcile(input: {
	previous: ReadonlyMap<string, CodingAgentState>;
	next: readonly CodingAgentTerminal[];
	unread: ReadonlySet<string>;
	/** Terminals in the tab being shown. */
	viewing: ReadonlySet<string>;
	/** The page is visible and the window has focus. */
	focused: boolean;
	initial: boolean;
}): Reconciled {
	const unread = new Set<string>();
	const alerts: AgentAlert[] = [];
	for (const item of input.next) {
		const seen = input.focused && input.viewing.has(item.terminalId);
		if (input.unread.has(item.terminalId) && !seen) unread.add(item.terminalId);
		if (input.initial || item.state === "working") continue;
		if (input.previous.get(item.terminalId) === item.state) continue;
		if (seen) continue;
		unread.add(item.terminalId);
		alerts.push({
			terminalId: item.terminalId,
			projectId: item.projectId,
			agent: item.agent,
			state: item.state,
		});
	}
	return { unread, alerts };
}

export interface AgentStatusSnapshot {
	terminals: readonly CodingAgentTerminal[];
	unread: ReadonlySet<string>;
}

export interface AgentStatusStore {
	/** Take a new list; returns the alerts it raised. */
	update(terminals: readonly CodingAgentTerminal[], initial: boolean): AgentAlert[];
	/** The terminals in the tab on screen, for the open project. */
	setViewing(terminalIds: readonly string[]): void;
	/** Re-check what the student can see, after focus or visibility changed. */
	refresh(): void;
	/** Terminals whose unread mark just cleared because the student looked. */
	onSeen(listener: (terminalIds: string[]) => void): () => void;
	subscribe(listener: () => void): () => void;
	getSnapshot(): AgentStatusSnapshot;
}

/** The student can see the page: it is visible and the window has focus. */
function pageHasFocus(): boolean {
	return document.visibilityState === "visible" && document.hasFocus();
}

export function createAgentStatusStore(focused = pageHasFocus): AgentStatusStore {
	let snapshot: AgentStatusSnapshot = { terminals: [], unread: new Set() };
	let viewing: ReadonlySet<string> = new Set();
	const listeners = new Set<() => void>();
	const seenListeners = new Set<(terminalIds: string[]) => void>();

	function publish(next: AgentStatusSnapshot) {
		snapshot = next;
		for (const listener of listeners) listener();
	}

	function clearSeen() {
		if (!focused()) return;
		const seen = [...snapshot.unread].filter((id) => viewing.has(id));
		if (seen.length === 0) return;
		const unread = new Set(snapshot.unread);
		for (const id of seen) unread.delete(id);
		publish({ ...snapshot, unread });
		for (const listener of seenListeners) listener(seen);
	}

	return {
		update(terminals, initial) {
			const result = reconcile({
				previous: new Map(snapshot.terminals.map((t) => [t.terminalId, t.state])),
				next: terminals,
				unread: snapshot.unread,
				viewing,
				focused: focused(),
				initial,
			});
			publish({ terminals, unread: result.unread });
			return result.alerts;
		},
		setViewing(terminalIds) {
			viewing = new Set(terminalIds);
			clearSeen();
		},
		refresh: clearSeen,
		onSeen(listener) {
			seenListeners.add(listener);
			return () => seenListeners.delete(listener);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getSnapshot: () => snapshot,
	};
}

/** Outside a workspace page there is no store, and no agent shows a mark. */
export const AgentStatusContext = createContext<AgentStatusStore | null>(null);

const EMPTY: AgentStatusSnapshot = { terminals: [], unread: new Set() };
const NO_SUBSCRIBE = () => () => {};

export function useAgentStatus(): AgentStatusSnapshot {
	const store = useContext(AgentStatusContext);
	return useSyncExternalStore(
		store ? store.subscribe : NO_SUBSCRIBE,
		store ? store.getSnapshot : () => EMPTY,
	);
}

export function useAgentStatusStore(): AgentStatusStore | null {
	return useContext(AgentStatusContext);
}

/** The mark of each terminal that has one, keyed by terminal id. */
export function marksByTerminal(
	snapshot: AgentStatusSnapshot,
): Map<string, AgentMark & { agent: CodingAgentTerminal["agent"] }> {
	const marks = new Map<string, AgentMark & { agent: CodingAgentTerminal["agent"] }>();
	for (const item of snapshot.terminals) {
		marks.set(item.terminalId, {
			state: item.state,
			unread: snapshot.unread.has(item.terminalId),
			agent: item.agent,
		});
	}
	return marks;
}

/** The most urgent mark in each project, for the project list. */
export function marksByProject(snapshot: AgentStatusSnapshot): Map<string, AgentMark> {
	const grouped = new Map<string, AgentMark[]>();
	for (const item of snapshot.terminals) {
		const list = grouped.get(item.projectId) ?? [];
		list.push({ state: item.state, unread: snapshot.unread.has(item.terminalId) });
		grouped.set(item.projectId, list);
	}
	const result = new Map<string, AgentMark>();
	for (const [projectId, marks] of grouped) {
		const best = mostUrgent(marks);
		if (best) result.set(projectId, best);
	}
	return result;
}

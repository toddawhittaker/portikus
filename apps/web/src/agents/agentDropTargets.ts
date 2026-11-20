/**
 * The agent panes mounted in this browser tab right now, each able to take
 * files the way a drop on it would. The preview's pick mode lists them so a
 * student can send a picked element to one (SPEC.md §14.6, §25.8). Nothing is
 * kept across a reload: a pane that is not mounted is not a target.
 */
import { useSyncExternalStore } from "react";

export interface AgentDropTarget {
	terminalId: string;
	/** The name the left pane shows for this agent. */
	label: string;
	/**
	 * Hand `files` to the pane exactly as a desktop drop on it would. True
	 * only when something arrived; on failure the pane has shown its own toast.
	 */
	deliver: (files: File[]) => Promise<boolean>;
}

const NONE: readonly AgentDropTarget[] = [];

// Insertion order is registration order. A registration that replaces a
// listed id keeps its place; a pane that unregisters and registers again, as
// a remounting pane does, goes to the end.
const targets = new Map<string, AgentDropTarget>();
const listeners = new Set<() => void>();
let snapshot: readonly AgentDropTarget[] = NONE;

function publish() {
	snapshot = targets.size === 0 ? NONE : [...targets.values()];
	for (const listener of listeners) listener();
}

/** List `target`; the returned function takes it off again. */
export function registerAgentDropTarget(target: AgentDropTarget): () => void {
	targets.set(target.terminalId, target);
	publish();
	return () => {
		// A later registration for the same id is not this one's to remove.
		if (targets.get(target.terminalId) !== target) return;
		targets.delete(target.terminalId);
		publish();
	};
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The agent panes that can take files right now, read outside React. */
export function getAgentDropTargets(): readonly AgentDropTarget[] {
	return snapshot;
}

/** The agent panes that can take files now, in the order they mounted. */
export function useAgentDropTargets(): readonly AgentDropTarget[] {
	return useSyncExternalStore(subscribe, getAgentDropTargets, getAgentDropTargets);
}

/**
 * The agent panes mounted in this browser tab right now, each able to take
 * files the way a drop on it would. The preview's pick mode lists them so a
 * student can send a picked element to one (SPEC.md §14.6, §25.8). Nothing is
 * kept across a reload: a pane that is not mounted is not a target.
 */
import { useSyncExternalStore } from "react";

export interface AgentDropTarget {
	terminalId: string;
	kind: "terminal" | "chat";
	/** The name the left pane shows for this agent. */
	label: string;
	/** Hand `files` to the pane exactly as a desktop drop on it would. */
	deliver: (files: File[]) => Promise<void>;
}

const NONE: readonly AgentDropTarget[] = [];

// Insertion order is registration order; a replaced id keeps its place.
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

function getSnapshot(): readonly AgentDropTarget[] {
	return snapshot;
}

/** The agent panes that can take files now, in the order they mounted. */
export function useAgentDropTargets(): readonly AgentDropTarget[] {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

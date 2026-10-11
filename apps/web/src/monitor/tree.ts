import type { UsageProcess } from "@portikus/contracts";

/** Each parent PID's direct children in one usage sample. */
function childMap(processes: readonly UsageProcess[]): Map<number, UsageProcess[]> {
	const children = new Map<number, UsageProcess[]>();
	for (const one of processes) {
		const list = children.get(one.ppid) ?? [];
		list.push(one);
		children.set(one.ppid, list);
	}
	return children;
}

/**
 * The processes a stop with children reaches (SPEC.md §18.3): descendants by
 * parent PID, plus the whole session when the root leads it, as the agent's
 * tree does. The agent finds the tree again when it acts, so this only sizes
 * the confirmation and picks the rows to hide once the tree has stopped.
 */
export function descendantsOf(
	root: UsageProcess,
	processes: readonly UsageProcess[],
): UsageProcess[] {
	const children = childMap(processes);
	const found = new Map<number, UsageProcess>();
	const queue = [root.pid];
	while (queue.length > 0) {
		const pid = queue.pop() as number;
		for (const child of children.get(pid) ?? []) {
			if (child.pid === root.pid || found.has(child.pid)) continue;
			found.set(child.pid, child);
			queue.push(child.pid);
		}
	}
	// An older agent sends session 0, which no root leads.
	if (root.session === root.pid) {
		for (const one of processes) {
			if (one.session === root.pid && one.pid !== root.pid) found.set(one.pid, one);
		}
	}
	return [...found.values()];
}

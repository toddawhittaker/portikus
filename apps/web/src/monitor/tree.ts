import type { UsageProcess } from "@portikus/contracts";

/** Each parent PID's direct children in one usage sample. */
export function childMap(
	processes: readonly UsageProcess[],
): Map<number, UsageProcess[]> {
	const children = new Map<number, UsageProcess[]>();
	for (const one of processes) {
		const list = children.get(one.ppid) ?? [];
		list.push(one);
		children.set(one.ppid, list);
	}
	return children;
}

/**
 * A process's descendants by parent PID (SPEC.md §18.3). The agent finds the
 * tree again when it acts, so this only sizes the confirmation and picks the
 * rows to hide once the tree has stopped.
 */
export function descendantsOf(
	rootPid: number,
	children: ReadonlyMap<number, readonly UsageProcess[]>,
): UsageProcess[] {
	const found: UsageProcess[] = [];
	const seen = new Set<number>([rootPid]);
	const queue = [rootPid];
	while (queue.length > 0) {
		const pid = queue.pop() as number;
		for (const child of children.get(pid) ?? []) {
			if (seen.has(child.pid)) continue;
			seen.add(child.pid);
			found.push(child);
			queue.push(child.pid);
		}
	}
	return found;
}

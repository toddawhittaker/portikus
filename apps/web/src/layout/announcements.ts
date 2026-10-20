/**
 * Layout versions announced on the workspace socket (SPEC.md §7.5). The
 * socket hook and the open project's layout persistence live in different
 * parts of the page, so they meet here. The newest version per project is
 * kept, so a project opened after its announcement still sees it.
 */
type Listener = (version: number) => void;

const latest = new Map<string, number>();
const listeners = new Map<string, Set<Listener>>();

function key(workspaceId: string, projectId: string): string {
	return `${workspaceId}/${projectId}`;
}

export function announceLayout(
	workspaceId: string,
	projectId: string,
	version: number,
): void {
	const k = key(workspaceId, projectId);
	if ((latest.get(k) ?? -1) >= version) return;
	latest.set(k, version);
	for (const listener of listeners.get(k) ?? []) listener(version);
}

/** Calls `listener` with each newer version, and now with the newest known one. */
export function onLayoutAnnounced(
	workspaceId: string,
	projectId: string,
	listener: Listener,
): () => void {
	const k = key(workspaceId, projectId);
	let set = listeners.get(k);
	if (!set) {
		set = new Set();
		listeners.set(k, set);
	}
	set.add(listener);
	const known = latest.get(k);
	if (known !== undefined) listener(known);
	return () => {
		set.delete(listener);
	};
}

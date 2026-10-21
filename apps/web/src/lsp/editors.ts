/**
 * The file editors on the page, by model URI, so a rename can wait for a tab
 * it opened and save each changed file through its tab's version-aware save
 * (SPEC.md §13.5, §13.6).
 */
/** False when the tab holds the save back, as an unresolved conflict does. */
type Saver = () => boolean;

const savers = new Map<string, Saver>();
const waiters = new Map<string, Array<() => void>>();

/** Called by an editor once its model holds the file's text. */
export function registerEditor(uri: string, save: Saver): () => void {
	savers.set(uri, save);
	for (const wake of waiters.get(uri) ?? []) wake();
	waiters.delete(uri);
	return () => {
		if (savers.get(uri) === save) savers.delete(uri);
	};
}

/** False when that tab holds the save back. */
export function saveEditor(uri: string): boolean {
	return savers.get(uri)?.() ?? false;
}

/** Resolves true once an editor for this URI is up, or false after `ms`. */
export function waitForEditor(uri: string, ms: number): Promise<boolean> {
	if (savers.has(uri)) return Promise.resolve(true);
	return new Promise((resolve) => {
		const wake = () => {
			clearTimeout(timer);
			resolve(true);
		};
		const timer = setTimeout(() => {
			const left = (waiters.get(uri) ?? []).filter((waiter) => waiter !== wake);
			if (left.length === 0) waiters.delete(uri);
			else waiters.set(uri, left);
			resolve(false);
		}, ms);
		waiters.set(uri, [...(waiters.get(uri) ?? []), wake]);
	});
}

/** How many waits are pending for a URI; for tests. */
export function pendingWaiters(uri: string): number {
	return waiters.get(uri)?.length ?? 0;
}

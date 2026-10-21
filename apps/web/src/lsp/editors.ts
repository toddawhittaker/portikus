/**
 * The file editors on the page, by model URI, so a rename can wait for a tab
 * it opened and save each changed file through its tab's version-aware save
 * (SPEC.md §13.5, §13.6).
 */
type Saver = () => void;

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

export function saveEditor(uri: string): void {
	savers.get(uri)?.();
}

/** Resolves true once an editor for this URI is up, or false after `ms`. */
export function waitForEditor(uri: string, ms: number): Promise<boolean> {
	if (savers.has(uri)) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), ms);
		const list = waiters.get(uri) ?? [];
		list.push(() => {
			clearTimeout(timer);
			resolve(true);
		});
		waiters.set(uri, list);
	});
}

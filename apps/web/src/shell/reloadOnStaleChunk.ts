/**
 * After a deploy, a tab that still holds the previous build's page asks for
 * lazily loaded chunks by their old hashed names, which no longer exist.
 * Vite reports that as a `vite:preloadError` event. Reloading the page picks
 * up the new build. The session flag stops a reload loop if the new build
 * is broken too: the second failure surfaces as an ordinary error.
 */
const FLAG = "portikus.reloadedForStaleChunk";

export function installStaleChunkReload(
	target: Pick<Window, "addEventListener"> = window,
	storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = sessionStorage,
	reload: () => void = () => window.location.reload(),
): void {
	target.addEventListener("vite:preloadError", (event) => {
		if (storage.getItem(FLAG) === "1") {
			storage.removeItem(FLAG);
			return;
		}
		event.preventDefault();
		storage.setItem(FLAG, "1");
		reload();
	});
}

/** Called once the page has loaded successfully, so a later stale chunk can reload again. */
export function clearStaleChunkFlag(
	storage: Pick<Storage, "removeItem"> = sessionStorage,
): void {
	storage.removeItem(FLAG);
}

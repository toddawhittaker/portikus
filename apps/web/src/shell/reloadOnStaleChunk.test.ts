import { describe, expect, it, vi } from "vitest";
import { clearStaleChunkFlag, installStaleChunkReload } from "./reloadOnStaleChunk.js";

function setup(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	const storage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	};
	const target = new EventTarget();
	const reload = vi.fn();
	installStaleChunkReload(target, storage, reload);
	return { store, storage, target, reload };
}

describe("installStaleChunkReload", () => {
	it("reloads once when a lazy chunk fails to load", () => {
		const { target, reload, store } = setup();
		const event = new Event("vite:preloadError", { cancelable: true });
		target.dispatchEvent(event);
		expect(reload).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
		expect(store.get("portikus.reloadedForStaleChunk")).toBe("1");
	});

	it("does not reload again if the reloaded page fails too", () => {
		const { target, reload, store } = setup({ "portikus.reloadedForStaleChunk": "1" });
		const event = new Event("vite:preloadError", { cancelable: true });
		target.dispatchEvent(event);
		expect(reload).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
		expect(store.has("portikus.reloadedForStaleChunk")).toBe(false);
	});

	it("clearStaleChunkFlag lets a later stale chunk reload again", () => {
		const { storage, store } = setup({ "portikus.reloadedForStaleChunk": "1" });
		clearStaleChunkFlag(storage);
		expect(store.size).toBe(0);
	});
});

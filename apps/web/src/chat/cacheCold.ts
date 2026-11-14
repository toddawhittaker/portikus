/**
 * Whether the chat's prompt cache has gone cold, by the browser clock
 * (SPEC.md §10.8). A chat whose host reports no cache lifetime is never
 * known to be cold.
 */
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { ChatState, ChatStore } from "./chatStore.js";

/** When the cache goes cold, on the browser clock; null when no cache is reported. */
function selectCacheColdAt(state: ChatState): number | null {
	const context = state.context;
	if (!context?.cache) return null;
	return context.cache.at + context.cache.ttlSeconds * 1000 + context.clockOffsetMs;
}

/** True from `at` on; re-renders once, when it passes. */
function usePast(at: number | null): boolean {
	const [past, setPast] = useState(() => at !== null && Date.now() >= at);
	useEffect(() => {
		if (at === null) {
			setPast(false);
			return;
		}
		const left = at - Date.now();
		setPast(left <= 0);
		if (left <= 0) return;
		const timer = setTimeout(() => setPast(true), left);
		return () => clearTimeout(timer);
	}, [at]);
	return past;
}

export function useCacheCold(store: ChatStore): boolean {
	return usePast(useStore(store, selectCacheColdAt));
}

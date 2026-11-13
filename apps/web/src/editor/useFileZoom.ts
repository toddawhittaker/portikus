import { type RefObject, useCallback, useEffect, useRef } from "react";
import { useEditorZoom } from "../layout/store.js";
import { stepZoom, wheelZoom } from "./zoom.js";

/**
 * The zoom of one file's editor or diff (SPEC.md §13.1), shared by both, and
 * Ctrl (Cmd) + wheel over `host` to change it, never the page's zoom. Monaco
 * and the wheel listener are set up once, so they read the newest zoom
 * through `current` and `set`, which never change, rather than being rebuilt
 * on every step.
 */
export function useFileZoom(path: string, host: RefObject<HTMLElement | null>) {
	const [zoom, setZoom] = useEditorZoom(path);
	const zoomRef = useRef(zoom);
	zoomRef.current = zoom;
	const setZoomRef = useRef(setZoom);
	setZoomRef.current = setZoom;

	useEffect(() => {
		const node = host.current;
		if (!node) return;
		const onWheel = wheelZoom((steps) =>
			setZoomRef.current(stepZoom(zoomRef.current, steps)),
		);
		node.addEventListener("wheel", onWheel, { passive: false });
		return () => node.removeEventListener("wheel", onWheel);
	}, [host]);

	const current = useCallback(() => zoomRef.current, []);
	const set = useCallback((percent: number) => setZoomRef.current(percent), []);
	return { zoom, setZoom, current, set };
}

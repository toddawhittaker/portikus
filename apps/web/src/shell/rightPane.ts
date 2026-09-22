/**
 * Which surface the right pane is showing (SPEC.md §8.4, §18.1, §18.2, §18.3). The
 * work area needs to switch it too, because a Preview tab offers a link to
 * the Running surface (BROWSER-HANDLING.md §12), so the choice is held by
 * the workspace screen rather than by the pane itself.
 */
import { createContext, useContext, useState } from "react";

export type RightPane = "files" | "checks" | "running" | "monitor";

export interface RightPaneApi {
	pane: RightPane;
	show: (pane: RightPane) => void;
}

/** Null outside a workspace screen, the way the layout store context is. */
export const RightPaneContext = createContext<RightPaneApi | null>(null);

/**
 * The shared choice, or one of this component's own when it is rendered
 * outside a workspace screen.
 */
export function useRightPaneState(): RightPaneApi {
	const shared = useContext(RightPaneContext);
	const [local, setLocal] = useState<RightPane>("files");
	return shared ?? { pane: local, show: setLocal };
}

/** Ask for a surface from elsewhere in the screen; nothing happens alone. */
export function useShowRightPane(): (pane: RightPane) => void {
	const shared = useContext(RightPaneContext);
	return shared?.show ?? (() => {});
}

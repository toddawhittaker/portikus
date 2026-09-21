/**
 * Which surface the right pane is showing (SPEC.md §8.4, §18.2). The work
 * area needs to switch it too, because a Preview tab offers a link to the
 * Running surface (BROWSER-HANDLING.md §12).
 */
import { createContext, useContext } from "react";

export type RightPane = "files" | "running";

export const RightPaneContext = createContext<{
	pane: RightPane;
	show: (pane: RightPane) => void;
}>({ pane: "files", show: () => {} });

export function useRightPane() {
	return useContext(RightPaneContext);
}

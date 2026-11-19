import { createContext } from "react";

/**
 * A place in a chat pane's title bar, before the zoom controls, where the
 * chat inside puts a control of its own (SPEC.md §10.2); null outside one.
 */
export const PaneBarSlot = createContext<HTMLElement | null>(null);

# PaneHandle

The splitter between resizable panes: the project list, the work area, the file tree, and terminal splits.

**Maps to:** `react-resizable-panels` `PanelResizeHandle`, which sets `data-resize-handle-state` (`inactive`, `hover`, `drag`). **Consumer provides:** `orientation` (`vertical` for side-by-side panes, `horizontal` for stacked), `label` naming the pane it resizes, and the `value`, `min`, `max` percentages for `aria-valuenow` and friends.

- Visible line is 1px `line`; the hit area is `size-pane-handle` (8px), centred on the line so panes keep their edges.
- Hover shows `line-strong` and a small grip; dragging draws a 2px `focus` line. No other motion.
- Keyboard: the handle is focusable and arrow keys resize (library default); Home and End move to the pane's minimum and maximum. The focus ring is the standard outline.
- Double-click resets to the default size stored in the layout (Zustand).

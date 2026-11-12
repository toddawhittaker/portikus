# Tabs

The tab strip of the centre work area: terminals, agent sessions, files and previews, closable and reorderable.

**Maps to:** Radix `Tabs` (`List`, `Trigger`) with dnd-kit `SortableContext` (horizontal list strategy) for reordering. **Consumer provides:** `tabs` (`id`, `kind`: `terminal` | `claude` | `codex` | `file` | `preview`, `label`, optional `title` for the full path, `dirty`, `ended`, `closable`), `activeId`, `onSelect`, `onClose`, `onReorder`, and the launcher Menu in `actions`.

- Height follows density (`density-comfortable-tab`). The strip is on the chrome (`surface-chrome`), even inside the work area. Each tab is as wide as its name, up to 240px, and all shrink together to `size-tab-floor`, where the label fades out and only the kind icon and close control remain.
- One selected look everywhere, including the right pane's tabs: a `surface-raised` face, `ink` text, and a 2px `accent` bar along the foot. A terminal tab looks the same as any other when selected. The work area's tabs take the `surface-work` face, so the tab opens onto the canvas under it.
- The inspector on administrator pages (Overview, Activity, Account) uses the right pane's strip on the inspector's own raised face: the selected tab keeps the transparent face and the 2px `accent` foot bar, and a tab whose content has a problem carries a 6px `status-warning` dot after its name. See Inspector.
- The kind icon of a selected tab takes `accent-text`. A Claude Code or Codex tab always carries `agent` in its icon. An agent's state shows only in its mark after the label: a turning `agent` ring while working (a whole ring under reduced motion), an amber triangle when it needs input, a check when it has finished.
- A tab chosen with the pointer shows no focus ring, so a ring carried over from a focused terminal or editor does not dress it as keyboard focus. Any key brings the ring back.
- Close button shows on the active, hovered or focused tab. A `dirty` file shows a dot instead, which becomes the close button on hover; closing a dirty tab asks first.
- An `ended` terminal (after a stop and restart) keeps its tab with an italic label and the accessible suffix "session ended"; its body shows the ended-session state with a "New terminal" action. Nothing is replayed.
- Keyboard: arrows move between tabs, Enter or Space activates, Delete closes, Alt+Shift+Left or Right moves the focused tab one place (a Portikus handler, announced in a polite live region: "app.ts moved to position 2 of 5"). Pointer reordering uses dnd-kit's pointer sensor with a 4px activation distance so clicks still select. The inset focus ring (`ring-offset-inset`) keeps the ring inside the strip.
- While dragging, the tab lifts with `shadow-sm` and the drop point is a 2px `focus` line. No other animation.
- Labels: the shell and folder for terminals ("zsh — todo-api"), the tool name for agents, the file name for files (path in the tooltip), the port for previews (":3000").

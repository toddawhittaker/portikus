# Tabs

The tab strip of the centre work area: terminals, agent sessions, files and previews, closable and reorderable.

**Maps to:** Radix `Tabs` (`List`, `Trigger`) with dnd-kit `SortableContext` (horizontal list strategy) for reordering. **Consumer provides:** `tabs` (`id`, `kind`: `terminal` | `claude` | `codex` | `file` | `preview`, `label`, optional `title` for the full path, `dirty`, `ended`, `closable`), `activeId`, `onSelect`, `onClose`, `onReorder`, and the launcher Menu in `actions`.

- Height follows density (`density-comfortable-tab`). Strip ground `surface-sunken`; active tab `surface-raised` with a 2px `accent` top edge. An active live terminal tab takes `terminal-bg` so it joins the terminal below it without a seam.
- Close button shows on the active, hovered or focused tab. A `dirty` file shows a dot instead, which becomes the close button on hover; closing a dirty tab asks first.
- An `ended` terminal (after a stop and restart) keeps its tab with an italic label and the accessible suffix "session ended"; its body shows the ended-session state with a "New terminal" action. Nothing is replayed.
- Keyboard: arrows move between tabs, Enter or Space activates, Delete closes, Alt+Shift+Left or Right moves the focused tab one place (a Portikus handler, announced in a polite live region: "app.ts moved to position 2 of 5"). Pointer reordering uses dnd-kit's pointer sensor with a 4px activation distance so clicks still select. The inset focus ring (`ring-offset-inset`) keeps the ring inside the strip.
- While dragging, the tab lifts with `shadow-sm` and the drop point is a 2px `focus` line. No other animation.
- Labels: the shell and folder for terminals ("zsh — todo-api"), the tool name for agents, the file name for files (path in the tooltip), the port for previews (":3000").

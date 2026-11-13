# Inspector

The panel that opens beside a table when a row is chosen: a person on Users, a line on Logs or Audit. On Users it holds the workspace and the account under three tabs.

**Maps to:** `WorkspaceDetail` in `apps/web/src/admin` (a `pk-card` with `pk-detail-head` and the right pane's `pk-pane-tabs` strip from `apps/web/src/shell/right-pane.css`) and the `pk-workbench` and `pk-inspector` classes in `apps/web/src/console.css`. The tabs are the real `TabsRoot`, `TabsList`, `TabsTrigger` and `TabsContent` from `packages/ui`; the frame around them lives only in `apps/web`, so the preview carries those rules itself. **Consumer provides:** the chosen row's name and identifier, its quiet state, its lifecycle actions, and the three panels.

- It opens beside the table once the content is 62rem wide (24rem or 400px wide), sticks to the top of the scrolling page and scrolls inside itself; narrower, it follows the table. It enters with a 180ms fade and 8px slide, none under reduced motion.
- The head stays in view: the name as an 18px heading, the identifier in `mono-small`, the state as a plain StateBadge, then Stop and Restart, with a close button at the end. Opening it moves focus to the heading.
- Tabs: Overview (errors first, then the resource guard, storage and limits, the image, Restore from backup and Rebuild), Activity (processes, ports, the agent log, recent audit events) and Account (the account, linked course accounts, and the actions that disable or delete). They use the right pane's strip on the inspector's raised face; the selected tab keeps a transparent face with the 2px `accent` foot bar and its icon in `accent-text`.
- Overview carries a 6px `status-warning` dot after its name when the workspace has a problem, named "needs attention" for screen readers.
- Every panel stays mounted, so a reading or an edit survives a tab switch.
- Sections inside are divided by `line`, each named by an overline; label and value pairs use one `dl` grid.
- The table row it belongs to takes the selected look: `accent-soft` behind every cell and a 2px `accent` bar on the first.

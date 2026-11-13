# AttentionStrip

What needs a person now, first on a page: one raised card listing each problem with its sentence, its evidence and its actions.

**Maps to:** the `pk-attention` classes in `apps/web/src/console.css` and the `pk-attention-table` rows in `apps/web/src/admin/health/health.css` (Health's "Needs attention"), with `QuietState` (`apps/web/src/common/QuietState.tsx`) for nothing to show. Not part of `packages/ui`; the preview is static markup with the real classes and carries the app's rules itself. **Consumer provides:** an overline heading with one count, and per problem the person or thing it concerns, a tag, a sentence of evidence and up to three actions.

- One card (`surface-raised`, `line` edge, `radius-md`) with a 3px `status-warning` start edge, `status-error` when something has failed. Rows are divided by `line`.
- Each row leads with the alert icon and the person as an entity link (`ink`, 600, underlined in `accent` on hover), then a tag and the evidence in `ink-muted`, then the actions: quiet Logs and Audit, and a secondary Inspect. Never a filled primary inside it.
- The count beside the overline is the page's only attention count; the rail's Health pill and the status bar's state say the same number, never a different one.
- When there is nothing to look at, show the quiet one-row state (`pk-quiet`): the portico glyph with a tick, a title and one line of detail, in a dashed `line` box. Never an empty card.
- On a narrow page each row wraps: the sentence takes the row and the actions move under it.

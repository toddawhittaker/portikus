# Table

A dense, sortable data table for administrator views: users, workspaces, audit events.

**Maps to:** a semantic `<table>` (TanStack Table may drive it; the markup and classes stay). **Consumer provides:** `columns` (`key`, `header`, optional `width`, `align: 'right'`, `mono`, `muted`, `sortable`, `sort`, `render`), `rows`, `rowKey`, optional `selectedKey`, and a `label`.

- Administrator views set `data-density="compact"`: rows are `density-compact-row` plus a two-line allowance, text `text-compact`.
- Header sticky at `z-sticky`; rows divided by `line`, no bands; hover `surface-hover`.
- On administrator and course pages the table is a reading surface: a 36px header on the table's own raised face in the overline style (11px, 600, spaced capitals, `ink-muted`), and a row opened in an inspector takes `accent-soft` behind every cell with a 2px `accent` bar on the first, the project list's selected look.
- Numeric columns (storage, ports, counts) are `pk-num`: end-aligned with tabular figures. Only numeric columns take tabular figures; names, dates and times keep the face's proportional figures. Identifiers, image versions and paths use `mono-body` or `mono-small`.
- State columns use StateBadge: `plain` for a normal state, the filled badge only for an exception such as an error.
- Row actions: at most one visible quiet action, then a `more` IconButton (drawn in `ink` at 18px, no edge) opening a Menu for the rest; never a row of buttons.
- A table wider than its place scrolls sideways in its own box, and only then is that box a named, focusable region (TableBox).
- Sort buttons set `aria-sort` on the header cell. Loading rows use Skeleton; an empty result uses EmptyState inside the table frame.
